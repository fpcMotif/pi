import { Schedule } from "effect";

import { LlmError } from "./agent-error.js";

export const MAX_LLM_RETRIES = 3;

// `aiError` is `Schema.Unknown` at the LlmError boundary (see agent-error.ts);
// `isRetryable` is the contract surface upstream `AiError.AiError` exposes for
// transient failures. Narrow with `in` so we never read off a non-object.
const isRetryableLlmError = (error: LlmError): boolean => {
	const ai = error.aiError;
	return typeof ai === "object" && ai !== null && "isRetryable" in ai && ai.isRetryable === true;
};

export const makeRetrySchedule = (maxRetries: number) =>
	Schedule.recurs(maxRetries).pipe(
		Schedule.while(({ input }: { readonly input: LlmError }) => isRetryableLlmError(input)),
	);
