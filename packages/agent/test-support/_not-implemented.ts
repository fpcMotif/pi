import { Effect } from "effect";

/**
 * Build the `Effect.die(...)` that single-purpose LanguageModel/OpenAi stubs
 * stamp into the methods they intentionally do NOT implement.
 *
 * The "single-purpose stub dies loudly on the other method" property
 * (CONTEXT.md:322) is the entire point: a `stubLanguageModelStream` paired
 * accidentally with a `generateText` call must surface that mistake to the
 * test author rather than silently return `undefined`. Centralising the
 * message format here keeps every stub's error string in lock-step
 * (`"<owner>: <method> not implemented"`) without diluting the loud-failure
 * contract.
 */
export const notImplemented = (owner: string, method: string): Effect.Effect<never> =>
	Effect.die(`${owner}: ${method} not implemented`);
