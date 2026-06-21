/**
 * App-layer composition for the Effect print host (ADR-0020): building and
 * resolving the layer performs no network IO — the OpenAI client is
 * constructed lazily and the durable session loads from the temp namespace.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CurrentSession } from "@earendil-works/pi-agent-core/effect";
import { Effect, SubscriptionRef } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildEffectPrintLayer } from "../src/modes/print-effect/layers.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-effect-layers-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("buildEffectPrintLayer", () => {
	it("resolves a durable CurrentSession with the default api url", async () => {
		const layer = buildEffectPrintLayer({
			model: "gpt-4o-mini",
			apiKey: "test-key",
			sessionsDir: dir,
			sessionId: "layer-test-1",
		});

		const turnCount = await Effect.runPromise(
			Effect.gen(function* () {
				const session = yield* CurrentSession;
				const state = yield* SubscriptionRef.get(session.state);
				return state.turnCount;
			}).pipe(Effect.provide(layer)) as Effect.Effect<number>,
		);

		expect(turnCount).toBe(0);
	});

	it("accepts an api url override", async () => {
		const layer = buildEffectPrintLayer({
			model: "gpt-4o-mini",
			apiKey: "test-key",
			apiUrl: "http://localhost:1/v1",
			sessionsDir: dir,
			sessionId: "layer-test-2",
		});

		const turnCount = await Effect.runPromise(
			Effect.gen(function* () {
				const session = yield* CurrentSession;
				const state = yield* SubscriptionRef.get(session.state);
				return state.turnCount;
			}).pipe(Effect.provide(layer)) as Effect.Effect<number>,
		);

		expect(turnCount).toBe(0);
	});
});
