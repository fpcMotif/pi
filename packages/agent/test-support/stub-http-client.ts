import { Effect, Layer } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

export interface StubHttpClientOptions {
	/** HTTP status code every request resolves to. */
	readonly status: number;
	/** Response body text (default `""`). JSON error bodies drive richer mapping. */
	readonly body?: string;
	/** Response headers (e.g. `retry-after`, `x-request-id`). */
	readonly headers?: Record<string, string>;
}

/**
 * A Layer providing {@link HttpClient.HttpClient} that resolves every request
 * to a canned `Response` with the given status / body / headers.
 *
 * Composed UNDER the real `OpenAiClient.layer` (rather than stubbing
 * `OpenAiClient` directly like `stubOpenAiClient`), this exercises the
 * provider's genuine HTTP-error path: `HttpClient.filterStatusOk` →
 * `StatusCodeError` → `@effect/ai-openai`'s `mapStatusCodeError` → `AiError`.
 * Use it to test HTTP-status-driven error mapping end-to-end without an API key.
 */
export const stubHttpClient = (options: StubHttpClientOptions): Layer.Layer<HttpClient.HttpClient> =>
	Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request) =>
			Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					new Response(options.body ?? "", { status: options.status, headers: options.headers }),
				),
			),
		),
	);
