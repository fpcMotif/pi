import { Effect } from "effect";

/**
 * Build a `LanguageModel.LanguageModel.of(...)` method-shaped thunk that dies
 * with a `"<stubName>: <method> not implemented"` defect.
 *
 * The `as never` cast is the established escape-hatch for the test-support
 * stubs (see commit 103d462) — `LanguageModel.LanguageModel.of`'s method
 * signatures expect specific Effect/Stream return types, and these stubs
 * intentionally bypass that validation because they're paired with code paths
 * that never call the dying method.
 */
export const dieUnimplemented = (stubName: string, method: string) =>
	(() => Effect.die(`${stubName}: ${method} not implemented`)) as never;
