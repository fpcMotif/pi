import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";

const ENV_KEYS = [
	"AI_GATEWAY_API_KEY",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"AWS_ACCESS_KEY_ID",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_PROFILE",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AZURE_OPENAI_API_KEY",
	"CEREBRAS_API_KEY",
	"CLOUDFLARE_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"DEEPSEEK_API_KEY",
	"FIREWORKS_API_KEY",
	"GCLOUD_PROJECT",
	"GEMINI_API_KEY",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_API_KEY",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_CLOUD_PROJECT",
	"GROQ_API_KEY",
	"HF_TOKEN",
	"KIMI_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"MISTRAL_API_KEY",
	"MOONSHOT_API_KEY",
	"OPENCODE_API_KEY",
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"TOGETHER_API_KEY",
	"XAI_API_KEY",
	"XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"ZAI_API_KEY",
] as const;

const savedEnv = new Map<string, string | undefined>();

for (const key of ENV_KEYS) {
	savedEnv.set(key, process.env[key]);
}

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = savedEnv.get(key);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
});

function clearTestEnv(): void {
	for (const key of ENV_KEYS) {
		delete process.env[key];
	}
}

describe("environment API key discovery", () => {
	it("finds every mapped API-key provider without falling back to unrelated variables", () => {
		clearTestEnv();
		const cases = [
			["openai", "OPENAI_API_KEY"],
			["azure-openai-responses", "AZURE_OPENAI_API_KEY"],
			["deepseek", "DEEPSEEK_API_KEY"],
			["google", "GEMINI_API_KEY"],
			["google-vertex", "GOOGLE_CLOUD_API_KEY"],
			["groq", "GROQ_API_KEY"],
			["cerebras", "CEREBRAS_API_KEY"],
			["xai", "XAI_API_KEY"],
			["openrouter", "OPENROUTER_API_KEY"],
			["vercel-ai-gateway", "AI_GATEWAY_API_KEY"],
			["zai", "ZAI_API_KEY"],
			["mistral", "MISTRAL_API_KEY"],
			["minimax", "MINIMAX_API_KEY"],
			["minimax-cn", "MINIMAX_CN_API_KEY"],
			["moonshotai", "MOONSHOT_API_KEY"],
			["moonshotai-cn", "MOONSHOT_API_KEY"],
			["huggingface", "HF_TOKEN"],
			["fireworks", "FIREWORKS_API_KEY"],
			["together", "TOGETHER_API_KEY"],
			["opencode", "OPENCODE_API_KEY"],
			["opencode-go", "OPENCODE_API_KEY"],
			["kimi-coding", "KIMI_API_KEY"],
			["cloudflare-workers-ai", "CLOUDFLARE_API_KEY"],
			["cloudflare-ai-gateway", "CLOUDFLARE_API_KEY"],
			["xiaomi", "XIAOMI_API_KEY"],
			["xiaomi-token-plan-cn", "XIAOMI_TOKEN_PLAN_CN_API_KEY"],
			["xiaomi-token-plan-ams", "XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
			["xiaomi-token-plan-sgp", "XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
		] as const;

		for (const [provider, envKey] of cases) {
			clearTestEnv();
			process.env[envKey] = `${provider}-secret`;

			expect(findEnvKeys(provider)).toEqual([envKey]);
			expect(getEnvApiKey(provider)).toBe(`${provider}-secret`);
		}
	});

	it("honors provider-specific precedence for multi-key providers", () => {
		clearTestEnv();
		process.env.ANTHROPIC_API_KEY = "anthropic-key";
		process.env.ANTHROPIC_OAUTH_TOKEN = "anthropic-oauth";
		process.env.COPILOT_GITHUB_TOKEN = "copilot";
		process.env.GH_TOKEN = "gh";
		process.env.GITHUB_TOKEN = "github";

		expect(findEnvKeys("anthropic")).toEqual(["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
		expect(getEnvApiKey("anthropic")).toBe("anthropic-oauth");
		expect(findEnvKeys("github-copilot")).toEqual(["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]);
		expect(getEnvApiKey("github-copilot")).toBe("copilot");
	});

	it("returns authenticated for each supported Bedrock ambient credential source", () => {
		const cases: Array<Record<string, string>> = [
			{ AWS_PROFILE: "default" },
			{ AWS_ACCESS_KEY_ID: "key", AWS_SECRET_ACCESS_KEY: "secret" },
			{ AWS_BEARER_TOKEN_BEDROCK: "token" },
			{ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials" },
			{ AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://localhost/credentials" },
			{ AWS_WEB_IDENTITY_TOKEN_FILE: "/tmp/token" },
		];

		for (const env of cases) {
			clearTestEnv();
			Object.assign(process.env, env);
			expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
			expect(findEnvKeys("amazon-bedrock")).toBeUndefined();
		}
	});

	it("does not authenticate unknown or incomplete ambient providers", () => {
		clearTestEnv();
		process.env.AWS_ACCESS_KEY_ID = "key-without-secret";

		expect(findEnvKeys("unknown-provider")).toBeUndefined();
		expect(getEnvApiKey("unknown-provider")).toBeUndefined();
		expect(getEnvApiKey("amazon-bedrock")).toBeUndefined();
	});

	it("recognizes Vertex ADC credentials only when project and location are configured", async () => {
		clearTestEnv();
		const tempDir = mkdtempSync(join(tmpdir(), "pi-ai-vertex-"));
		const adcPath = join(tempDir, "application_default_credentials.json");
		writeFileSync(adcPath, "{}");

		try {
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(existsSync(adcPath)).toBe(true);

			process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
			process.env.GOOGLE_CLOUD_PROJECT = "project";
			expect(getEnvApiKey("google-vertex")).toBeUndefined();

			process.env.GOOGLE_CLOUD_LOCATION = "us-central1";
			expect(getEnvApiKey("google-vertex")).toBe("<authenticated>");

			delete process.env.GOOGLE_CLOUD_PROJECT;
			process.env.GCLOUD_PROJECT = "legacy-project";
			expect(getEnvApiKey("google-vertex")).toBe("<authenticated>");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
