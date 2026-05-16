import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";

// env-api-keys resolves API keys from known environment variables. These tests
// manipulate process.env and restore it afterwards.

const TOUCHED_ENV_KEYS = [
	"OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_CLOUD_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"ZAI_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"MOONSHOT_API_KEY",
	"HF_TOKEN",
	"FIREWORKS_API_KEY",
	"TOGETHER_API_KEY",
	"OPENCODE_API_KEY",
	"KIMI_API_KEY",
	"CLOUDFLARE_API_KEY",
	"XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
] as const;

const savedEnv = new Map<string, string | undefined>();

// env-api-keys eagerly loads node:fs/os/path via dynamic import on module
// evaluation. After a fresh import we yield a few microtask/macrotask turns so
// those promises settle before the synchronous credential checks run.
async function importEnvApiKeysModule(): Promise<typeof import("../src/env-api-keys.js")> {
	const mod = await import("../src/env-api-keys.js");
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	return mod;
}

beforeEach(() => {
	for (const key of TOUCHED_ENV_KEYS) {
		savedEnv.set(key, process.env[key]);
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of TOUCHED_ENV_KEYS) {
		const value = savedEnv.get(key);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	savedEnv.clear();
});

describe("findEnvKeys", () => {
	it("returns the configured env var for a known provider when it is set", () => {
		process.env.OPENAI_API_KEY = "sk-test";
		expect(findEnvKeys("openai")).toEqual(["OPENAI_API_KEY"]);
	});

	it("returns undefined for a known provider when its env var is unset", () => {
		expect(findEnvKeys("openai")).toBeUndefined();
	});

	it("returns undefined for an unknown provider with no env mapping", () => {
		expect(findEnvKeys("totally-unknown-provider")).toBeUndefined();
	});

	it("reports github-copilot precedence across its candidate env vars", () => {
		process.env.GH_TOKEN = "gh-token";
		process.env.GITHUB_TOKEN = "github-token";
		expect(findEnvKeys("github-copilot")).toEqual(["GH_TOKEN", "GITHUB_TOKEN"]);

		process.env.COPILOT_GITHUB_TOKEN = "copilot-token";
		expect(findEnvKeys("github-copilot")).toEqual(["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]);
	});

	it("prefers ANTHROPIC_OAUTH_TOKEN ahead of ANTHROPIC_API_KEY", () => {
		process.env.ANTHROPIC_API_KEY = "anthropic-key";
		expect(findEnvKeys("anthropic")).toEqual(["ANTHROPIC_API_KEY"]);

		process.env.ANTHROPIC_OAUTH_TOKEN = "anthropic-oauth";
		expect(findEnvKeys("anthropic")).toEqual(["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
	});

	it("maps the full provider env table", () => {
		const cases: Array<[string, string]> = [
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
		];

		for (const [provider, envVar] of cases) {
			process.env[envVar] = `${envVar}-value`;
			expect(findEnvKeys(provider)).toEqual([envVar]);
			delete process.env[envVar];
		}
	});
});

describe("getEnvApiKey", () => {
	it("returns the value of the first configured env var", () => {
		process.env.OPENAI_API_KEY = "sk-direct";
		expect(getEnvApiKey("openai")).toBe("sk-direct");
	});

	it("returns undefined for a provider with no key set", () => {
		expect(getEnvApiKey("openai")).toBeUndefined();
	});

	it("returns undefined for an unknown provider", () => {
		expect(getEnvApiKey("totally-unknown-provider")).toBeUndefined();
	});

	describe("google-vertex", () => {
		// hasVertexAdcCredentials() caches the existence check at module scope,
		// so each ADC scenario needs a freshly imported module instance.
		afterEach(() => {
			vi.resetModules();
		});

		it("returns the explicit API key when GOOGLE_CLOUD_API_KEY is present", async () => {
			process.env.GOOGLE_CLOUD_API_KEY = "vertex-key";
			const mod = await importEnvApiKeysModule();
			expect(mod.getEnvApiKey("google-vertex")).toBe("vertex-key");
		});

		it("returns <authenticated> when GOOGLE_APPLICATION_CREDENTIALS, project and location are all set", async () => {
			// package.json itself always exists, so it is a safe credentials path.
			process.env.GOOGLE_APPLICATION_CREDENTIALS = new URL("../package.json", import.meta.url).pathname;
			process.env.GOOGLE_CLOUD_PROJECT = "my-project";
			process.env.GOOGLE_CLOUD_LOCATION = "us-central1";
			const mod = await importEnvApiKeysModule();
			expect(mod.getEnvApiKey("google-vertex")).toBe("<authenticated>");
		});

		it("falls back to GCLOUD_PROJECT for the project check", async () => {
			process.env.GOOGLE_APPLICATION_CREDENTIALS = new URL("../package.json", import.meta.url).pathname;
			process.env.GCLOUD_PROJECT = "fallback-project";
			process.env.GOOGLE_CLOUD_LOCATION = "us-central1";
			const mod = await importEnvApiKeysModule();
			expect(mod.getEnvApiKey("google-vertex")).toBe("<authenticated>");
		});

		it("returns undefined when ADC credentials exist but project/location are missing", async () => {
			process.env.GOOGLE_APPLICATION_CREDENTIALS = new URL("../package.json", import.meta.url).pathname;
			const mod = await importEnvApiKeysModule();
			expect(mod.getEnvApiKey("google-vertex")).toBeUndefined();
		});

		it("returns undefined when GOOGLE_APPLICATION_CREDENTIALS points to a missing file", async () => {
			process.env.GOOGLE_APPLICATION_CREDENTIALS = "/nonexistent/path/to/creds.json";
			process.env.GOOGLE_CLOUD_PROJECT = "my-project";
			process.env.GOOGLE_CLOUD_LOCATION = "us-central1";
			const mod = await importEnvApiKeysModule();
			expect(mod.getEnvApiKey("google-vertex")).toBeUndefined();
		});

		it("checks the default ADC path when GOOGLE_APPLICATION_CREDENTIALS is unset", async () => {
			// No GAC env var: hasVertexAdcCredentials falls back to the
			// ~/.config/gcloud default path, which does not exist in CI.
			process.env.GOOGLE_CLOUD_PROJECT = "my-project";
			process.env.GOOGLE_CLOUD_LOCATION = "us-central1";
			const mod = await importEnvApiKeysModule();
			expect(mod.getEnvApiKey("google-vertex")).toBeUndefined();
		});
	});

	describe("amazon-bedrock", () => {
		it("returns <authenticated> when AWS_PROFILE is set", () => {
			process.env.AWS_PROFILE = "default";
			expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
		});

		it("returns <authenticated> when AWS access key and secret are both set", () => {
			process.env.AWS_ACCESS_KEY_ID = "AKIA";
			process.env.AWS_SECRET_ACCESS_KEY = "secret";
			expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
		});

		it("returns <authenticated> for a Bedrock bearer token", () => {
			process.env.AWS_BEARER_TOKEN_BEDROCK = "bearer";
			expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
		});

		it("returns <authenticated> for ECS / IRSA credential sources", () => {
			process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = "/creds";
			expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
			delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;

			process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = "http://169.254.170.2/creds";
			expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
			delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;

			process.env.AWS_WEB_IDENTITY_TOKEN_FILE = "/var/run/token";
			expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
		});

		it("returns undefined when no AWS credential source is configured", () => {
			expect(getEnvApiKey("amazon-bedrock")).toBeUndefined();
		});

		it("treats a lone AWS_ACCESS_KEY_ID without secret as not authenticated", () => {
			process.env.AWS_ACCESS_KEY_ID = "AKIA";
			expect(getEnvApiKey("amazon-bedrock")).toBeUndefined();
		});
	});
});
