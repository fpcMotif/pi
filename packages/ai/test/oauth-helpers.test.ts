import { afterEach, describe, expect, it } from "vitest";
import { getImagesApiProvider, registerImagesApiProvider } from "../src/images-api-registry.js";
import { generateImages } from "../src/images.js";
import { cleanupSessionResources, registerSessionResourceCleanup } from "../src/session-resources.js";
import {
	getOAuthApiKey,
	getOAuthProvider,
	getOAuthProviderInfoList,
	getOAuthProviders,
	openaiCodexOAuthProvider,
	refreshOAuthToken,
	registerOAuthProvider,
	resetOAuthProviders,
	unregisterOAuthProvider,
} from "../src/utils/oauth/index.js";
import { oauthErrorHtml, oauthSuccessHtml } from "../src/utils/oauth/oauth-page.js";
import { generatePKCE } from "../src/utils/oauth/pkce.js";
import * as oauthBarrel from "../src/oauth.js";
import type { ImagesApi, ImagesModel } from "../src/types.js";
import type { OAuthCredentials, OAuthProviderInterface } from "../src/utils/oauth/types.js";

const customProviderId = "test-oauth-provider";
const customImagesApi = "test-images-api" as ImagesApi;

afterEach(() => {
	unregisterOAuthProvider(customProviderId);
	resetOAuthProviders();
});

function credentials(overrides: Partial<OAuthCredentials> = {}): OAuthCredentials {
	return {
		refresh: "refresh-token",
		access: "access-token",
		expires: Date.now() + 60_000,
		...overrides,
	};
}

function customOAuthProvider(
	options: {
		refresh?: (credentials: OAuthCredentials) => Promise<OAuthCredentials>;
		getApiKey?: (credentials: OAuthCredentials) => string;
	} = {},
): OAuthProviderInterface {
	return {
		id: customProviderId,
		name: "Test OAuth Provider",
		login: async () => credentials(),
		refreshToken: options.refresh ?? (async (creds) => ({ ...creds, access: `${creds.access}-refreshed` })),
		getApiKey: options.getApiKey ?? ((creds) => `bearer:${creds.access}`),
	};
}

describe("PKCE generation", () => {
	it("generates verifier and challenge strings that are base64url-safe", async () => {
		const { verifier, challenge } = await generatePKCE();

		expect(verifier).toHaveLength(43);
		expect(challenge).toHaveLength(43);
		expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(challenge).not.toBe(verifier);
	});
});

describe("OAuth provider registry", () => {
	it("re-exports the OAuth registry from the public OAuth barrel", () => {
		expect(oauthBarrel.getOAuthProviders()).toEqual(getOAuthProviders());
		expect(oauthBarrel.openaiCodexOAuthProvider.id).toBe("openai-codex");
	});

	it("registers, lists, unregisters, and resets custom OAuth providers", () => {
		const provider = customOAuthProvider();
		registerOAuthProvider(provider);

		expect(getOAuthProvider(customProviderId)).toBe(provider);
		expect(getOAuthProviders()).toContain(provider);
		expect(getOAuthProviderInfoList()).toContainEqual({
			id: customProviderId,
			name: "Test OAuth Provider",
			available: true,
		});

		unregisterOAuthProvider(customProviderId);
		expect(getOAuthProvider(customProviderId)).toBeUndefined();

		registerOAuthProvider({
			...customOAuthProvider(),
			id: "openai-codex",
			name: "Replacement OpenAI Codex",
		});
		expect(getOAuthProvider("openai-codex")?.name).toBe("Replacement OpenAI Codex");
		unregisterOAuthProvider("openai-codex");
		expect(getOAuthProvider("openai-codex")).toBe(openaiCodexOAuthProvider);

		registerOAuthProvider(provider);
		resetOAuthProviders();
		expect(getOAuthProvider(customProviderId)).toBeUndefined();
	});

	it("refreshes and extracts OAuth API keys through the registry", async () => {
		const provider = customOAuthProvider();
		registerOAuthProvider(provider);

		await expect(refreshOAuthToken(customProviderId, credentials({ access: "old" }))).resolves.toMatchObject({
			access: "old-refreshed",
		});

		const active = await getOAuthApiKey(customProviderId, {
			[customProviderId]: credentials({ access: "fresh", expires: Date.now() + 60_000 }),
		});
		expect(active).toEqual({
			newCredentials: credentials({ access: "fresh", expires: active?.newCredentials.expires }),
			apiKey: "bearer:fresh",
		});

		const expired = await getOAuthApiKey(customProviderId, {
			[customProviderId]: credentials({ access: "stale", expires: Date.now() - 1 }),
		});
		expect(expired?.newCredentials.access).toBe("stale-refreshed");
		expect(expired?.apiKey).toBe("bearer:stale-refreshed");
		expect(await getOAuthApiKey(customProviderId, {})).toBeNull();
	});

	it("reports unknown providers and refresh failures without leaking provider errors", async () => {
		registerOAuthProvider(
			customOAuthProvider({
				refresh: async () => {
					throw new Error("secret refresh detail");
				},
			}),
		);

		await expect(refreshOAuthToken("missing-provider", credentials())).rejects.toThrow(
			"Unknown OAuth provider: missing-provider",
		);
		await expect(getOAuthApiKey("missing-provider", {})).rejects.toThrow("Unknown OAuth provider: missing-provider");
		await expect(
			getOAuthApiKey(customProviderId, {
				[customProviderId]: credentials({ expires: Date.now() - 1 }),
			}),
		).rejects.toThrow(`Failed to refresh OAuth token for ${customProviderId}`);
	});
});

describe("OAuth callback HTML", () => {
	it("escapes success and error page content", () => {
		const success = oauthSuccessHtml(`ok <script>"'</script>`);
		const failure = oauthErrorHtml("bad <b>", `details & "quotes"`);

		expect(success).toContain("ok &lt;script&gt;&quot;&#39;&lt;/script&gt;");
		expect(success).not.toContain("<script>");
		expect(failure).toContain("bad &lt;b&gt;");
		expect(failure).toContain("details &amp; &quot;quotes&quot;");
	});
});

describe("session resource cleanup registry", () => {
	it("runs registered cleanups, supports unregister, and aggregates failures", () => {
		const calls: Array<string | undefined> = [];
		const unregisterFirst = registerSessionResourceCleanup((sessionId) => calls.push(`first:${sessionId}`));
		registerSessionResourceCleanup((sessionId) => calls.push(`second:${sessionId}`));

		cleanupSessionResources("session-1");
		unregisterFirst();
		cleanupSessionResources();

		expect(calls).toEqual(["first:session-1", "second:session-1", "second:undefined"]);

		const unregisterThrowing = registerSessionResourceCleanup(() => {
			throw new Error("cleanup failed");
		});
		expect(() => cleanupSessionResources("session-2")).toThrow(AggregateError);
		unregisterThrowing();
	});
});

describe("images API registry", () => {
	it("wraps registered image providers with API mismatch checks", async () => {
		const model: ImagesModel<ImagesApi> = {
			id: "image-model",
			name: "Image Model",
			provider: "openrouter",
			api: customImagesApi,
			baseUrl: "https://images.example.test",
			input: ["text"],
			output: ["image"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
		};
		await expect(
			generateImages({ ...model, api: "missing-images-api" }, { input: [{ type: "text", text: "draw" }] }),
		).rejects.toThrow("No API provider registered for api: missing-images-api");

		registerImagesApiProvider(
			{
				api: customImagesApi,
				generateImages: async (registeredModel, context) => ({
					api: registeredModel.api,
					provider: registeredModel.provider,
					model: registeredModel.id,
					output: context.input,
					stopReason: "stop",
					timestamp: 1,
				}),
			},
			"test-source",
		);

		const provider = getImagesApiProvider(customImagesApi);
		await expect(provider?.generateImages(model, { input: [{ type: "text", text: "draw" }] })).resolves.toMatchObject(
			{
				api: customImagesApi,
				model: "image-model",
				output: [{ type: "text", text: "draw" }],
			},
		);

		expect(() =>
			provider?.generateImages({ ...model, api: "openrouter-images" }, { input: [{ type: "text", text: "draw" }] }),
		).toThrow("Mismatched api: openrouter-images expected test-images-api");
	});
});
