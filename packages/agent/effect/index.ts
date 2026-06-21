/**
 * Public surface of the pi-agent-core Effect lane (consolidation-backlog P2).
 * Built to `dist/effect` and exported as
 * `@earendil-works/pi-agent-core/effect` so hosts outside this package —
 * starting with ADR-0020's print-mode adapter in pi-coding-agent — consume
 * the lane through one seam instead of relative paths.
 *
 * Internal pipeline modules (attempt-stream, lift-part, history-accumulator,
 * token-capture, compaction internals, retry schedule) are deliberately not
 * re-exported: they are implementation, not interface.
 */
export * from "./agent-error.js";
export * from "./agent-event.js";
export * from "./agent-input.js";
export * from "./current-session.js";
export * from "./hooks.js";
export * from "./providers/openai.js";
export * from "./session-state.js";
// Named, not `export *`: `makeSession` and the bare `durable` are factory
// implementation — hosts go through `Session` or the `CurrentSession` seam.
export { Session, type SessionConfig } from "./session.js";
export * from "./stores/session-store.js";
