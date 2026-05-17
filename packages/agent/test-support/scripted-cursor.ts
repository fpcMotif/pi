import { Effect, Ref } from "effect";

export interface ScriptedCursor {
	readonly next: Effect.Effect<number>;
}

export const makeScriptedCursor: Effect.Effect<ScriptedCursor> = Effect.gen(function* () {
	const callIndex = yield* Ref.make(0);
	return {
		next: Ref.getAndUpdate(callIndex, (n) => n + 1),
	};
});
