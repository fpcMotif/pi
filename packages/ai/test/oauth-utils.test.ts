import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { OAuthCredentials, OAuthProviderInterface } from "../src/utils/oauth/types.js";

afterEach(() => {
	resetOAuthProviders();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

// =============================================================================
// oauth-page.ts
// =============================================================================

describe("oauth-page", () => {
	it("oauthSuccessHtml returns HTML with the supplied success message", () => {
		const html = oauthSuccessHtml("All good.");
		expect(html).toContain("Authentication successful");
		expect(html).toContain("All good.");
		expect(html.startsWith("<!doctype html>")).toBe(true);
	});

	it("oauthErrorHtml escapes special HTML characters in the message", () => {
		const html = oauthErrorHtml("Bad <script>\"&'</script>");
		expect(html).toContain("Authentication failed");
		expect(html).toContain("Bad &lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;");
		// Raw script tag content must not appear in output
		expect(html).not.toMatch(/<script>"&'<\/script>/);
	});

	it("oauthErrorHtml renders optional details when provided", () => {
		const html = oauthErrorHtml("Failure", "extra details here");
		expect(html).toContain("extra details here");
		expect(html).toContain('class="details"');
	});

	it("oauthErrorHtml omits the details block when no details are provided", () => {
		const html = oauthErrorHtml("Failure");
		expect(html).not.toContain('class="details"');
	});
});

// =============================================================================
// pkce.ts
// =============================================================================

describe("pkce", () => {
	it("generatePKCE returns a base64url-encoded verifier and SHA-256 challenge", async () => {
		const { verifier, challenge } = await generatePKCE();
		expect(typeof verifier).toBe("string");
		expect(typeof challenge).toBe("string");
		// base64url has no +, /, or =
		expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(verifier.length).toBeGreaterThan(0);
		expect(challenge.length).toBeGreaterThan(0);
	});

	it("generatePKCE produces distinct values on repeat calls", async () => {
		const a = await generatePKCE();
		const b = await generatePKCE();
		expect(a.verifier).not.toBe(b.verifier);
		expect(a.challenge).not.toBe(b.challenge);
	});

	it("the challenge equals SHA-256(verifier) base64url-encoded", async () => {
		const { verifier, challenge } = await generatePKCE();
		const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
		const bytes = new Uint8Array(hashBuffer);
		let binary = "";
		for (const byte of bytes) {
			binary += String.fromCharCode(byte);
		}
		const expected = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
		expect(challenge).toBe(expected);
	});
});

// =============================================================================
// oauth/index.ts — provider registry + high-level API
// =============================================================================

describe("oauth provider registry", () => {
	it("getOAuthProvider returns the built-in openai-codex provider", () => {
		const provider = getOAuthProvider("openai-codex");
		expect(provider).toBe(openaiCodexOAuthProvider);
	});

	it("getOAuthProvider returns undefined for unknown providers", () => {
		expect(getOAuthProvider("does-not-exist")).toBeUndefined();
	});

	it("getOAuthProviders returns all registered providers", () => {
		const providers = getOAuthProviders();
		expect(providers).toContain(openaiCodexOAuthProvider);
	});

	it("registerOAuthProvider adds a new provider to the registry", () => {
		const custom: OAuthProviderInterface = {
			id: "custom-provider",
			name: "Custom",
			async login() {
				return { refresh: "r", access: "a", expires: 0 };
			},
			async refreshToken(c) {
				return c;
			},
			getApiKey(c) {
				return c.access;
			},
		};
		registerOAuthProvider(custom);
		expect(getOAuthProvider("custom-provider")).toBe(custom);
		expect(getOAuthProviders()).toContain(custom);
	});

	it("unregisterOAuthProvider removes custom providers entirely", () => {
		const custom: OAuthProviderInterface = {
			id: "removable",
			name: "Removable",
			async login() {
				return { refresh: "r", access: "a", expires: 0 };
			},
			async refreshToken(c) {
				return c;
			},
			getApiKey(c) {
				return c.access;
			},
		};
		registerOAuthProvider(custom);
		expect(getOAuthProvider("removable")).toBe(custom);
		unregisterOAuthProvider("removable");
		expect(getOAuthProvider("removable")).toBeUndefined();
	});

	it("unregisterOAuthProvider restores the built-in implementation for built-in IDs", () => {
		const fake: OAuthProviderInterface = {
			id: "openai-codex",
			name: "Fake",
			async login() {
				return { refresh: "r", access: "a", expires: 0 };
			},
			async refreshToken(c) {
				return c;
			},
			getApiKey() {
				return "fake";
			},
		};
		registerOAuthProvider(fake);
		expect(getOAuthProvider("openai-codex")).toBe(fake);
		unregisterOAuthProvider("openai-codex");
		expect(getOAuthProvider("openai-codex")).toBe(openaiCodexOAuthProvider);
	});

	it("resetOAuthProviders restores the registry to built-ins", () => {
		const custom: OAuthProviderInterface = {
			id: "ephemeral",
			name: "Ephemeral",
			async login() {
				return { refresh: "r", access: "a", expires: 0 };
			},
			async refreshToken(c) {
				return c;
			},
			getApiKey(c) {
				return c.access;
			},
		};
		registerOAuthProvider(custom);
		expect(getOAuthProvider("ephemeral")).toBe(custom);
		resetOAuthProviders();
		expect(getOAuthProvider("ephemeral")).toBeUndefined();
		expect(getOAuthProvider("openai-codex")).toBe(openaiCodexOAuthProvider);
	});

	it("getOAuthProviderInfoList returns deprecated OAuthProviderInfo entries", () => {
		const list = getOAuthProviderInfoList();
		expect(list).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "openai-codex", name: expect.any(String), available: true }),
			]),
		);
	});
});

// =============================================================================
// refreshOAuthToken (deprecated wrapper)
// =============================================================================

describe("refreshOAuthToken", () => {
	it("forwards the call to the matching provider's refreshToken", async () => {
		const refreshed: OAuthCredentials = { refresh: "new-r", access: "new-a", expires: 999 };
		const fake: OAuthProviderInterface = {
			id: "fake-refresher",
			name: "Fake refresher",
			async login() {
				return refreshed;
			},
			refreshToken: vi.fn(async (_c) => refreshed),
			getApiKey(c) {
				return c.access;
			},
		};
		registerOAuthProvider(fake);

		const original: OAuthCredentials = { refresh: "old-r", access: "old-a", expires: 0 };
		const result = await refreshOAuthToken("fake-refresher", original);
		expect(result).toBe(refreshed);
		expect(fake.refreshToken).toHaveBeenCalledWith(original);
	});

	it("throws when provider id is unknown", async () => {
		await expect(refreshOAuthToken("missing", { refresh: "", access: "", expires: 0 })).rejects.toThrow(
			"Unknown OAuth provider: missing",
		);
	});
});

// =============================================================================
// getOAuthApiKey
// =============================================================================

describe("getOAuthApiKey", () => {
	it("returns null when no credentials exist for the provider", async () => {
		const result = await getOAuthApiKey("openai-codex", {});
		expect(result).toBeNull();
	});

	it("returns the API key without refresh for non-expired credentials", async () => {
		const credentials: OAuthCredentials = {
			refresh: "r",
			access: "fresh-access-token",
			expires: Date.now() + 60_000,
		};
		const result = await getOAuthApiKey("openai-codex", { "openai-codex": credentials });
		expect(result).not.toBeNull();
		expect(result?.apiKey).toBe("fresh-access-token");
		expect(result?.newCredentials).toBe(credentials);
	});

	it("refreshes expired credentials and returns the updated apiKey", async () => {
		const refreshed: OAuthCredentials = {
			refresh: "new-r",
			access: "new-access",
			expires: Date.now() + 60_000,
		};
		const fake: OAuthProviderInterface = {
			id: "expiring",
			name: "Expiring",
			async login() {
				return refreshed;
			},
			refreshToken: vi.fn(async () => refreshed),
			getApiKey(c) {
				return c.access;
			},
		};
		registerOAuthProvider(fake);

		const expired: OAuthCredentials = {
			refresh: "old-r",
			access: "old-access",
			expires: Date.now() - 1000,
		};
		const result = await getOAuthApiKey("expiring", { expiring: expired });
		expect(result).not.toBeNull();
		expect(result?.apiKey).toBe("new-access");
		expect(result?.newCredentials).toBe(refreshed);
		expect(fake.refreshToken).toHaveBeenCalledWith(expired);
	});

	it("throws when refreshToken throws", async () => {
		const fake: OAuthProviderInterface = {
			id: "broken-refresh",
			name: "Broken refresh",
			async login() {
				return { refresh: "", access: "", expires: 0 };
			},
			refreshToken: async () => {
				throw new Error("boom");
			},
			getApiKey() {
				return "";
			},
		};
		registerOAuthProvider(fake);

		const expired: OAuthCredentials = {
			refresh: "old-r",
			access: "old-access",
			expires: Date.now() - 1000,
		};
		await expect(getOAuthApiKey("broken-refresh", { "broken-refresh": expired })).rejects.toThrow(
			"Failed to refresh OAuth token for broken-refresh",
		);
	});

	it("throws when the provider id is unknown", async () => {
		await expect(getOAuthApiKey("nope", { nope: { refresh: "", access: "", expires: 0 } })).rejects.toThrow(
			"Unknown OAuth provider: nope",
		);
	});
});
