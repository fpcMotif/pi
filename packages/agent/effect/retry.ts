import { Schedule } from "effect";

import type { LlmError } from "./agent-error.js";

/**
 * Default transient-error retry cap when `SessionConfig.maxLlmRetries` is
 * omitted. With the default, a persistently-retryable failure gets 4 total
 * tries (initial + 3 retries) before the last error propagates. Slice 35
 * makes this per-session configurable via `SessionConfig.maxLlmRetries`.
 *
 * Renamed from `MAX_LLM_RETRIES` to reflect that it is the *default* cap, not
 * an absolute ceiling — callers override it via `SessionConfig.maxLlmRetries`.
 */
export const DEFAULT_MAX_LLM_RETRIES = 3;

/**
 * Build the retry schedule for the per-attempt inner stream. Recurs up to
 * `maxRetries` times, AND halts early if the failing error is non-retryable
 * (per `AiError.reason.isRetryable`).
 *
 * The schedule's `input` is the stream's error type — here that's `LlmError`
 * (we map `AiError → LlmError` before the retry boundary so the schedule sees
 * pi's error shape). `maxRetries: 0` produces a schedule that never recurs,
 * so the single attempt's failure propagates immediately.
 */
export const makeRetrySchedule = (maxRetries: number) =>
	Schedule.recurs(maxRetries).pipe(
		Schedule.while(({ input }) => ((input as LlmError).aiError as { readonly isRetryable: boolean }).isRetryable),
	);
