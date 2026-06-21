/**
 * `CurrentSession` promotes the ADR-0009 `Session` to a `Context.Service`
 * (ADR-0020 decision 4; the consolidation-backlog P0). The ADR-0008 runtime
 * host resolves the process's one session from its ManagedRuntime, and tests
 * swap in a fake Session Layer without touching call sites.
 *
 * A registry of many sessions (newSession / fork / switchSession — the legacy
 * `AgentSessionRuntime` surface) is deliberately NOT designed here: that
 * surface belongs to interactive mode and gets its own seam when interactive
 * mode crosses to the Effect lane (ADR-0020 decision 4, "defer registry").
 *
 * `Session.durable` does not take a `SessionConfig` today, so `layerDurable`
 * exposes none either — the gap is the factory's, not this service's.
 */
import { Context, Layer } from "effect";

import type { AgentError } from "./agent-error.js";
import { Session, type SessionConfig } from "./session.js";
import type { SessionStore } from "./stores/session-store.js";

export class CurrentSession extends Context.Service<CurrentSession, Session>()(
	"@earendil-works/pi-agent-core/CurrentSession",
) {}

/**
 * One non-durable session per layer scope (`Session.make(config)`); state
 * lives only in memory. The unconfigured call mirrors `Session.empty`.
 */
export const layerEphemeral = (config?: SessionConfig): Layer.Layer<CurrentSession> =>
	Layer.effect(CurrentSession, Session.make(config));

/**
 * One durable session per layer scope (`Session.durable(sessionId)`): the
 * previous snapshot is loaded at layer build, every `send` persists the
 * post-bump snapshot through the `SessionStore` in context, and a
 * successfully completed `send` persists the final snapshot including the
 * assistant turn.
 */
export const layerDurable = (sessionId: string): Layer.Layer<CurrentSession, AgentError, SessionStore> =>
	Layer.effect(CurrentSession, Session.durable(sessionId));
