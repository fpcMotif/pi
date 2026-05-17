import { Schedule } from "effect";

import { LlmError } from "./agent-error.js";

export const MAX_LLM_RETRIES = 3;

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> => typeof value === "object" && value !== null;

const isRetryableLlmError = (error: LlmError): boolean => isRecord(error.aiError) && error.aiError.isRetryable === true;

export const makeRetrySchedule = (maxRetries: number) =>
	Schedule.recurs(maxRetries).pipe(
		Schedule.while(({ input }: { readonly input: LlmError }) => isRetryableLlmError(input)),
	);
