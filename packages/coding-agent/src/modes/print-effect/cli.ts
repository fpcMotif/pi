/**
 * CLI glue for `--effect` (ADR-0020): resolves model + API key with the
 * legacy resolvers (no AgentSessionRuntime, no extensions), builds the app
 * layer, and hands off to the runner. Boundary module — it touches real
 * auth storage, the on-disk model registry, and settings; the runner and
 * layer composition behind it carry the tested logic.
 */
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Args } from "../../cli/args.js";
import { getAgentDir } from "../../config.js";
import { AuthStorage } from "../../core/auth-storage.js";
import { ModelRegistry } from "../../core/model-registry.js";
import { resolveCliModel } from "../../core/model-resolver.js";
import { SettingsManager } from "../../core/settings-manager.js";
import { buildEffectPrintLayer } from "./layers.js";
import { effectModelSupport, runEffectPrintMode } from "./runner.js";

export interface EffectPrintCliInput {
	readonly parsed: Args;
	readonly appMode: "print" | "json";
	/** The RESOLVED legacy session dir (--session-dir / env / settings) — the effect namespace lives beside it. */
	readonly sessionDir?: string;
	readonly initialMessage?: string;
	readonly initialImages?: ImageContent[];
}

export async function runEffectPrintModeFromCli(input: EffectPrintCliInput): Promise<number> {
	const { parsed, appMode, sessionDir, initialMessage, initialImages } = input;

	if (parsed.events === "v1") {
		console.error(
			"Error: --events v1 through the Effect lane is not implemented yet (ADR-0020 step 3). Pass --events v2 or drop --effect.",
		);
		return 1;
	}
	// Require the schema choice to be EXPLICIT in json mode: the ADR's end
	// state defaults to v1, so a silent v2-today default would flip every
	// script's output schema when the v1 mapper lands.
	if (appMode === "json" && parsed.events === undefined) {
		console.error(
			"Error: --effect --mode json requires an explicit --events v2 while the v1 mapper is unimplemented (v1 becomes the default at ADR-0020 step 3).",
		);
		return 1;
	}
	if (parsed.continue || parsed.resume || parsed.session || parsed.fork || parsed.noSession) {
		console.error(
			"Warning: session flags (--continue/--resume/--session/--fork/--no-session) are ignored with --effect; each run starts a fresh effect-session (ADR-0020).",
		);
	}
	if (initialImages !== undefined && initialImages.length > 0) {
		console.error("Error: --effect does not support image attachments yet (ADR-0020 tracer-bullet scope).");
		return 1;
	}

	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);

	const cliResolution = resolveCliModel({
		cliProvider: parsed.provider,
		cliModel: parsed.model,
		modelRegistry,
	});
	if (cliResolution.error) {
		console.error(`Error: ${cliResolution.error}`);
		return 1;
	}
	if (cliResolution.warning) {
		console.error(`Warning: ${cliResolution.warning}`);
	}

	let model = cliResolution.model;
	if (!model) {
		const settings = SettingsManager.create(process.cwd(), getAgentDir());
		const defaultProvider = settings.getDefaultProvider();
		const defaultModel = settings.getDefaultModel();
		if (defaultProvider && defaultModel) {
			model = modelRegistry.find(defaultProvider, defaultModel);
		}
	}
	if (!model) {
		console.error('Error: no model resolved for --effect. Pass --model "<provider>/<id>" (e.g. --model openai/gpt-4o-mini).');
		return 1;
	}

	const support = effectModelSupport(model);
	if (!support.supported) {
		console.error(`Error: ${support.reason}`);
		return 1;
	}

	const apiKey = await authStorage.getApiKey(model.provider);
	if (!apiKey) {
		console.error(`Error: no API key available for provider "${model.provider}".`);
		return 1;
	}

	// The parallel namespace sits BESIDE the resolved legacy session dir, so
	// --session-dir / env / settings overrides (and any sandbox built on
	// them) carry over to flagged runs (ADR-0020 decision 7).
	const effectSessionsDir = resolve(sessionDir ?? join(getAgentDir(), "sessions"), "..", "effect-sessions");
	const appLayer = buildEffectPrintLayer({
		model: model.id,
		apiKey,
		...(model.baseUrl === undefined ? {} : { apiUrl: model.baseUrl }),
		sessionsDir: effectSessionsDir,
		sessionId: randomUUID(),
	});

	return runEffectPrintMode(appLayer, {
		mode: appMode === "json" ? "json" : "text",
		...(initialMessage === undefined ? {} : { initialMessage }),
		messages: parsed.messages,
	});
}
