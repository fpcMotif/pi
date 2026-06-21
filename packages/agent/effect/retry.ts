import { type Duration, Schedule } from "effect";
import { AiError } from "effect/unstable/ai";

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
 * Build the retry schedule for the per-attempt inner stream. Exponential
 * backoff from a 250ms base (250ms → 500ms → 1s → …), jittered to 80–120% of
 * each delay, intersected (`Schedule.both` = max-delay/AND semantics) with a
 * recurrence cap of `maxRetries`, AND halting early if the failing error is
 * non-retryable (per `AiError.reason.isRetryable`).
 *
 * The schedule's `input` is the stream's error type — here that's `LlmError`
 * (we map `AiError → LlmError` before the retry boundary so the schedule sees
 * pi's error shape). `maxRetries: 0` produces a schedule that never recurs,
 * so the single attempt's failure propagates immediately — no backoff delay.
 */
export const makeRetrySchedule = (maxRetries: number) =>
	Schedule.exponential("250 millis").pipe(
		Schedule.jittered,
		Schedule.both(Schedule.recurs(maxRetries)),
		Schedule.while<LlmError, [Duration.Duration, number]>(
			({ input }) => AiError.isAiError(input.aiError) && input.aiError.isRetryable,
		),
	);
