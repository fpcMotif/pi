import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	loginOpenAICodex,
	openaiCodexOAuthProvider,
	refreshOpenAICodexToken,
} from "../src/utils/oauth/openai-codex.js";

// Build a JWT with the chatgpt_account_id claim that the codex flow expects.
function makeJwt(accountId: string | undefined): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const claims = accountId
		? { "https://api.openai.com/auth": { chatgpt_account_id: accountId } }
		: { "https://api.openai.com/auth": {} };
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	return `${header}.${payload}.signature`;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("refreshOpenAICodexToken", () => {
	it("returns updated credentials on a successful refresh", async () => {
		const access = makeJwt("acc_42");
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: access,
							refresh_token: "new-refresh",
							expires_in: 3600,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			),
		);

		const result = await refreshOpenAICodexToken("old-refresh-token");
		expect(result.access).toBe(access);
		expect(result.refresh).toBe("new-refresh");
		expect(result.accountId).toBe("acc_42");
		expect(typeof result.expires).toBe("number");
		expect(result.expires).toBeGreaterThan(Date.now());
	});

	it("throws when the access token has no account id claim", async () => {
		const accessNoAccountId = makeJwt(undefined);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: accessNoAccountId,
							refresh_token: "new-refresh",
							expires_in: 3600,
						}),
						{ status: 200 },
					),
			),
		);
		await expect(refreshOpenAICodexToken("old-refresh-token")).rejects.toThrow(
			"Failed to extract accountId from token",
		);
	});

	it("throws when the response is missing required fields", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ access_token: "abc" }), { status: 200 })),
		);
		await expect(refreshOpenAICodexToken("old")).rejects.toThrow(/missing fields/);
	});

	it("includes the response body in the failure message on non-2xx responses", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("server detail", { status: 500, statusText: "Server Error" })),
		);
		await expect(refreshOpenAICodexToken("token")).rejects.toThrow(/500.*server detail/);
	});

	it("falls back to statusText when response.text() returns empty", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 502, statusText: "Bad Gateway" })),
		);
		await expect(refreshOpenAICodexToken("token")).rejects.toThrow(/502.*Bad Gateway/);
	});

	it("propagates network/fetch errors as a failure message", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		await expect(refreshOpenAICodexToken("token")).rejects.toThrow(/refresh error.*network down/);
	});

	it("handles non-Error throws inside fetch", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw "boom-string";
			}),
		);
		await expect(refreshOpenAICodexToken("token")).rejects.toThrow(/boom-string/);
	});
});

describe("openaiCodexOAuthProvider integration", () => {
	it("exposes the expected metadata", () => {
		expect(openaiCodexOAuthProvider.id).toBe("openai-codex");
		expect(openaiCodexOAuthProvider.name).toContain("ChatGPT");
		expect(openaiCodexOAuthProvider.usesCallbackServer).toBe(true);
	});

	it("getApiKey returns the access token", () => {
		const apiKey = openaiCodexOAuthProvider.getApiKey({
			refresh: "r",
			access: "the-access-token",
			expires: 0,
		});
		expect(apiKey).toBe("the-access-token");
	});

	it("refreshToken delegates to refreshOpenAICodexToken", async () => {
		const access = makeJwt("acc_provider");
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ access_token: access, refresh_token: "rrr", expires_in: 60 }), {
						status: 200,
					}),
			),
		);
		const refreshed = await openaiCodexOAuthProvider.refreshToken({
			refresh: "old",
			access: "old-access",
			expires: 0,
		});
		expect(refreshed.access).toBe(access);
		expect(refreshed.accountId).toBe("acc_provider");
	});
});

describe("loginOpenAICodex", () => {
	let realFetch: typeof fetch;
	let captures: { params?: URLSearchParams } = {};

	beforeEach(() => {
		captures = {};
		realFetch = global.fetch;
	});

	afterEach(() => {
		global.fetch = realFetch;
	});

	function mockTokenExchange(opts: { accountId?: string; ok?: boolean }) {
		const access = makeJwt(opts.accountId);
		global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://auth.openai.com/oauth/token") {
				captures.params = new URLSearchParams((init?.body as string) || "");
				if (opts.ok === false) {
					return new Response("denied", { status: 400 });
				}
				return new Response(JSON.stringify({ access_token: access, refresh_token: "RR", expires_in: 60 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			// Pass-through to the real fetch for any other URL (e.g. callback server).
			return realFetch(input, init);
		}) as typeof fetch;
		return { access };
	}

	it("completes the login flow using onManualCodeInput", async () => {
		const { access } = mockTokenExchange({ accountId: "acc_manual" });
		// Use a unique, valid-state code injected via onManualCodeInput.

		let observedAuthUrl: string | undefined;
		const result = await loginOpenAICodex({
			onAuth: ({ url }) => {
				observedAuthUrl = url;
			},
			onPrompt: async () => {
				throw new Error("onPrompt should not run when manual input wins");
			},
			onManualCodeInput: async () => {
				// Wait until the redirect URL is known so we can extract the state.
				return "the-code";
			},
		});

		expect(observedAuthUrl).toContain("auth.openai.com/oauth/authorize");
		expect(observedAuthUrl).toContain("originator=pi");
		expect(result.access).toBe(access);
		expect(result.accountId).toBe("acc_manual");
		expect(captures.params?.get("grant_type")).toBe("authorization_code");
		expect(captures.params?.get("code")).toBe("the-code");
	});

	it("uses onPrompt when no manual handler is provided and the server gets no callback", async () => {
		const { access } = mockTokenExchange({ accountId: "acc_prompt" });

		// To force the callback server to return no code without waiting, occupy port 1455
		// before login so server.listen errors out and waitForCode resolves to null.
		const blocker = http.createServer(() => {});
		await new Promise<void>((resolve, reject) => {
			blocker.listen(1455, "127.0.0.1", resolve).on("error", reject);
		});

		try {
			const result = await loginOpenAICodex({
				onAuth: () => {},
				onPrompt: async () => "prompt-code",
			});
			expect(result.access).toBe(access);
			expect(result.accountId).toBe("acc_prompt");
			expect(captures.params?.get("code")).toBe("prompt-code");
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("parses a redirect URL pasted by the user", async () => {
		mockTokenExchange({ accountId: "acc_url" });

		const blocker = http.createServer(() => {});
		await new Promise<void>((resolve, reject) => {
			blocker.listen(1455, "127.0.0.1", resolve).on("error", reject);
		});

		try {
			let authUrl = "";
			const result = await loginOpenAICodex({
				onAuth: ({ url }) => {
					authUrl = url;
				},
				onPrompt: async () => {
					// State must match the value embedded in the authorize URL
					const params = new URL(authUrl).searchParams;
					return `http://localhost:1455/auth/callback?code=url-code&state=${params.get("state")}`;
				},
			});
			expect(result.accountId).toBe("acc_url");
			expect(captures.params?.get("code")).toBe("url-code");
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("throws on state mismatch from the prompt", async () => {
		mockTokenExchange({ accountId: "acc_state" });

		const blocker = http.createServer(() => {});
		await new Promise<void>((resolve, reject) => {
			blocker.listen(1455, "127.0.0.1", resolve).on("error", reject);
		});

		try {
			await expect(
				loginOpenAICodex({
					onAuth: () => {},
					onPrompt: async () => "http://localhost:1455/auth/callback?code=c&state=WRONG",
				}),
			).rejects.toThrow("State mismatch");
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("propagates manual-input errors via the manualError path", async () => {
		mockTokenExchange({ accountId: "acc" });

		await expect(
			loginOpenAICodex({
				onAuth: () => {},
				onPrompt: async () => "should-not-prompt",
				onManualCodeInput: async () => {
					throw new Error("paste failed");
				},
			}),
		).rejects.toThrow("paste failed");
	});

	it("falls back to onPrompt when manual input returns empty", async () => {
		const { access } = mockTokenExchange({ accountId: "acc_fallback" });

		const blocker = http.createServer(() => {});
		await new Promise<void>((resolve, reject) => {
			blocker.listen(1455, "127.0.0.1", resolve).on("error", reject);
		});

		try {
			const result = await loginOpenAICodex({
				onAuth: () => {},
				onPrompt: async () => "from-prompt-code",
				onManualCodeInput: async () => "",
			});
			expect(result.access).toBe(access);
			expect(captures.params?.get("code")).toBe("from-prompt-code");
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("propagates manual-input errors that resolve after waitForCode returns null", async () => {
		mockTokenExchange({ accountId: "acc" });

		// Occupy 1455 so waitForCode resolves to null immediately.
		const blocker = http.createServer(() => {});
		await new Promise<void>((resolve, reject) => {
			blocker.listen(1455, "127.0.0.1", resolve).on("error", reject);
		});

		try {
			let release: (() => void) | undefined;
			const delayed = new Promise<string>((_, reject) => {
				release = () => reject(new Error("late error"));
			});

			const flow = loginOpenAICodex({
				onAuth: () => setTimeout(() => release?.(), 5),
				onPrompt: async () => {
					throw new Error("should not prompt");
				},
				onManualCodeInput: () => delayed,
			});
			await expect(flow).rejects.toThrow("late error");
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("throws when no code can be obtained", async () => {
		mockTokenExchange({ accountId: "acc" });

		const blocker = http.createServer(() => {});
		await new Promise<void>((resolve, reject) => {
			blocker.listen(1455, "127.0.0.1", resolve).on("error", reject);
		});

		try {
			await expect(
				loginOpenAICodex({
					onAuth: () => {},
					onPrompt: async () => "",
				}),
			).rejects.toThrow("Missing authorization code");
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("throws when token exchange fails", async () => {
		mockTokenExchange({ accountId: "acc", ok: false });

		const blocker = http.createServer(() => {});
		await new Promise<void>((resolve, reject) => {
			blocker.listen(1455, "127.0.0.1", resolve).on("error", reject);
		});

		try {
			await expect(
				loginOpenAICodex({
					onAuth: () => {},
					onPrompt: async () => "some-code",
				}),
			).rejects.toThrow(/token exchange failed.*400/);
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("throws when the exchanged access token has no account id", async () => {
		mockTokenExchange({ accountId: undefined });

		const blocker = http.createServer(() => {});
		await new Promise<void>((resolve, reject) => {
			blocker.listen(1455, "127.0.0.1", resolve).on("error", reject);
		});

		try {
			await expect(
				loginOpenAICodex({
					onAuth: () => {},
					onPrompt: async () => "some-code",
				}),
			).rejects.toThrow(/Failed to extract accountId/);
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("returns the code from the local callback server when the browser succeeds", async () => {
		const { access } = mockTokenExchange({ accountId: "acc_cb" });

		let observedAuthUrl = "";
		const flow = loginOpenAICodex({
			onAuth: ({ url }) => {
				observedAuthUrl = url;
			},
			onPrompt: async () => "should-not-prompt",
		});

		// Wait until the local server is up and we have the authorize URL.
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		const params = new URL(observedAuthUrl).searchParams;

		// Send the callback request to the local server with the correct state.
		const cbResponse = await fetch(
			`http://127.0.0.1:1455/auth/callback?code=browser-code&state=${params.get("state")}`,
		);
		expect(cbResponse.ok).toBe(true);

		const result = await flow;
		expect(result.access).toBe(access);
		expect(result.accountId).toBe("acc_cb");
		expect(captures.params?.get("code")).toBe("browser-code");
	});

	it("returns error responses from the local callback server for invalid requests", async () => {
		const { access } = mockTokenExchange({ accountId: "acc_err" });

		let observedAuthUrl = "";
		const flow = loginOpenAICodex({
			onAuth: ({ url }) => {
				observedAuthUrl = url;
			},
			onPrompt: async () => "should-not-prompt",
		});

		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		// State mismatch
		const r1 = await fetch("http://127.0.0.1:1455/auth/callback?code=c&state=BAD");
		expect(r1.status).toBe(400);
		expect(await r1.text()).toContain("State mismatch");
		// Wrong path
		const r2 = await fetch("http://127.0.0.1:1455/elsewhere");
		expect(r2.status).toBe(404);
		expect(await r2.text()).toContain("Callback route not found");

		// Now send a valid callback so the flow finishes cleanly.
		const params = new URL(observedAuthUrl).searchParams;
		const r3 = await fetch(`http://127.0.0.1:1455/auth/callback?state=${params.get("state")}`);
		expect(r3.status).toBe(400);
		expect(await r3.text()).toContain("Missing authorization code");

		const r4 = await fetch(`http://127.0.0.1:1455/auth/callback?code=final-code&state=${params.get("state")}`);
		expect(r4.ok).toBe(true);
		const result = await flow;
		expect(result.access).toBe(access);
	});
});
