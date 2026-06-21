/**
 * Production layer composition for the Effect print-mode host (ADR-0020):
 * one durable `CurrentSession` over the file-backed `SessionStore` in the
 * parallel `effect-sessions` namespace (decision 7), plus the OpenAI
 * `LanguageModel` provider from pi-agent-core (decision 5).
 */
import {
	type AgentError,
	type CurrentSession,
	layerDurable,
	layerKeyValueStore,
	openAiLanguageModelLayer,
} from "@earendil-works/pi-agent-core/effect";
import { Layer } from "effect";
import type { LanguageModel } from "effect/unstable/ai";
import { layerFileSystemKeyValueStore } from "./fs-key-value-store.js";

export interface EffectPrintLayerOptions {
	readonly model: string;
	readonly apiKey: string;
	readonly apiUrl?: string;
	/** Directory of the parallel session namespace (e.g. ~/.pi/agent/effect-sessions). */
	readonly sessionsDir: string;
	readonly sessionId: string;
}

export const buildEffectPrintLayer = (
	options: EffectPrintLayerOptions,
): Layer.Layer<CurrentSession | LanguageModel.LanguageModel, AgentError> =>
	Layer.mergeAll(
		layerDurable(options.sessionId).pipe(
			Layer.provide(layerKeyValueStore.pipe(Layer.provide(layerFileSystemKeyValueStore(options.sessionsDir)))),
		),
		openAiLanguageModelLayer({
			model: options.model,
			apiKey: options.apiKey,
			...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
		}),
	);
