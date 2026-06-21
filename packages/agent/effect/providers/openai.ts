/**
 * Production OpenAI provider wiring (ADR-0003: providers narrowed to
 * `@effect/ai-openai` + `@effect/ai-openrouter` + the in-repo Codex Responses
 * provider; ADR-0005: provider ownership lives in pi-agent-core).
 *
 * `openAiLanguageModelLayerHttp` leaves the `HttpClient` requirement open so
 * tests drive the provider's genuine HTTP path with a stub client;
 * `openAiLanguageModelLayer` bakes in the fetch-based client for hosts
 * (ADR-0020's print-mode adapter). Two adapters, one seam.
 */
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Layer, Redacted } from "effect";
import type { LanguageModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import type * as HttpClient from "effect/unstable/http/HttpClient";

export interface OpenAiLanguageModelOptions {
	/** Model identifier passed through to the OpenAI API (e.g. "gpt-4o-mini"). */
	readonly model: string;
	readonly apiKey: string;
	/** Override the API base URL (default: https://api.openai.com/v1). */
	readonly apiUrl?: string;
}

export const openAiLanguageModelLayerHttp = (
	options: OpenAiLanguageModelOptions,
): Layer.Layer<LanguageModel.LanguageModel, never, HttpClient.HttpClient> =>
	OpenAiLanguageModel.layer({ model: options.model }).pipe(
		Layer.provide(
			OpenAiClient.layer({
				apiKey: Redacted.make(options.apiKey),
				...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
			}),
		),
	);

export const openAiLanguageModelLayer = (
	options: OpenAiLanguageModelOptions,
): Layer.Layer<LanguageModel.LanguageModel> =>
	openAiLanguageModelLayerHttp(options).pipe(Layer.provide(FetchHttpClient.layer));
