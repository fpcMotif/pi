import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	loginOpenAICodex,
	openaiCodexOAuthProvider,
	refreshOpenAICodexToken,
} from "../src/utils/oauth/openai-codex.js";

const ACCOUNT_CLAIM = "https://api.openai.com/auth";

function accessToken(accountId: string | undefined): string {
	const payload = accountId ? { [ACCOUNT_CLAIM]: { chatgpt_account_id: accountId } } : { [ACCOUNT_CLAIM]: {} };
	return `header.${btoa(JSON.stringify(payload))}.signature`;
}

function stubTokenExchange(
	realFetch: typeof fetch,
	options: { accountId?: string; refresh?: string; expiresIn?: number } = {},
): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
		if (String(input) === "https://auth.openai.com/oauth/token") {
			const body = init?.body;
			if (!(body instanceof URLSearchParams)) {
				throw new Error("expected OAuth token request body");
			}
			return Response.json({
				access_token: accessToken(options.accountId ?? "account-login"),
				refresh_token: options.refresh ?? "refresh-login",
				expires_in: options.expiresIn ?? 120,
			});
		}
		return realFetch(input, init);
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

async function waitForOAuthRuntime(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("OpenAI Codex OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("does not write token refresh failures to stderr", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => {
				return new Response(
					JSON.stringify({
						error: {
							message: "Could not validate your token. Please try signing in again.",
							type: "invalid_request_error",
						},
					}),
					{ status: 401, statusText: "Unauthorized", headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		await expect(refreshOpenAICodexToken("invalid-refresh-token")).rejects.toThrow(
			/OpenAI Codex token refresh failed \(401\).*Could not validate your token/,
		);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("refreshes credentials and extracts the ChatGPT account id from the access token", async () => {
		vi.setSystemTime(10_000);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => {
				return Response.json({
					access_token: accessToken("account-123"),
					refresh_token: "new-refresh",
					expires_in: 60,
				});
			}),
		);

		await expect(refreshOpenAICodexToken("old-refresh")).resolves.toEqual({
			access: accessToken("account-123"),
			refresh: "new-refresh",
			expires: 70_000,
			accountId: "account-123",
		});
		expect(fetch).toHaveBeenCalledWith(
			"https://auth.openai.com/oauth/token",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: expect.any(URLSearchParams),
			}),
		);
	});

	it("rejects refresh responses that omit required token fields or account ids", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn<() => Promise<Response>>()
				.mockResolvedValueOnce(Response.json({ access_token: "access-only" }))
				.mockResolvedValueOnce(
					Response.json({
						access_token: accessToken(undefined),
						refresh_token: "new-refresh",
						expires_in: 60,
					}),
				),
		);

		await expect(refreshOpenAICodexToken("old-refresh")).rejects.toThrow(
			"OpenAI Codex token refresh response missing fields",
		);
		await expect(refreshOpenAICodexToken("old-refresh")).rejects.toThrow("Failed to extract accountId from token");
	});

	it("rejects refresh responses with malformed access tokens", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (): Promise<Response> =>
					Response.json({
						access_token: "header.@@@.signature",
						refresh_token: "new-refresh",
						expires_in: 60,
					}),
			),
		);

		await expect(refreshOpenAICodexToken("old-refresh")).rejects.toThrow("Failed to extract accountId from token");

		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (): Promise<Response> =>
					Response.json({
						access_token: "header.payload",
						refresh_token: "new-refresh",
						expires_in: 60,
					}),
			),
		);

		await expect(refreshOpenAICodexToken("old-refresh")).rejects.toThrow("Failed to extract accountId from token");
	});

	it("wraps fetch exceptions and exposes credentials through the provider adapter", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn<() => Promise<Response>>()
				.mockRejectedValueOnce(new Error("network down"))
				.mockResolvedValueOnce(
					Response.json({
						access_token: accessToken("account-456"),
						refresh_token: "new-refresh",
						expires_in: 30,
					}),
				),
		);

		await expect(refreshOpenAICodexToken("old-refresh")).rejects.toThrow(
			"OpenAI Codex token refresh error: network down",
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => Promise.reject("offline")),
		);
		await expect(refreshOpenAICodexToken("old-refresh")).rejects.toThrow("OpenAI Codex token refresh error: offline");

		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => new Response("", { status: 503, statusText: "Service Unavailable" })),
		);
		await expect(refreshOpenAICodexToken("old-refresh")).rejects.toThrow(
			"OpenAI Codex token refresh failed (503): Service Unavailable",
		);

		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (): Promise<Response> =>
					Response.json({
						access_token: accessToken("account-456"),
						refresh_token: "new-refresh",
						expires_in: 30,
					}),
			),
		);
		await expect(
			openaiCodexOAuthProvider.refreshToken({
				access: "old-access",
				refresh: "old-refresh",
				expires: 1,
			}),
		).resolves.toMatchObject({
			access: accessToken("account-456"),
			refresh: "new-refresh",
			accountId: "account-456",
		});
		expect(openaiCodexOAuthProvider.getApiKey({ access: "access-token", refresh: "refresh", expires: 1 })).toBe(
			"access-token",
		);
	});

	it("logs in from a manually pasted redirect URL and exchanges the authorization code", async () => {
		await waitForOAuthRuntime();
		vi.setSystemTime(100_000);
		const authUrls: string[] = [];
		const progress: string[] = [];
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit): Promise<Response> => {
			const body = init?.body;
			if (!(body instanceof URLSearchParams)) {
				throw new Error("expected OAuth token request body");
			}
			expect(body.get("grant_type")).toBe("authorization_code");
			expect(body.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
			expect(body.get("code")).toBe("manual-code");
			expect(body.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
			expect(body.get("code_verifier")).toBeTruthy();
			return Response.json({
				access_token: accessToken("account-login"),
				refresh_token: "refresh-login",
				expires_in: 120,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			loginOpenAICodex({
				onAuth: ({ url, instructions }) => {
					authUrls.push(url);
					if (instructions) progress.push(instructions);
				},
				onPrompt: async () => "unused",
				onManualCodeInput: async () => {
					const authUrl = authUrls.at(-1);
					if (!authUrl) throw new Error("missing auth url");
					const state = new URL(authUrl).searchParams.get("state");
					return `http://localhost:1455/auth/callback?code=manual-code&state=${state}`;
				},
			}),
		).resolves.toEqual({
			access: accessToken("account-login"),
			refresh: "refresh-login",
			expires: 220_000,
			accountId: "account-login",
		});
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(authUrls).toHaveLength(1);
		const authorizeUrl = new URL(authUrls[0]);
		expect(authorizeUrl.origin).toBe("https://auth.openai.com");
		expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorizeUrl.searchParams.get("originator")).toBe("pi");
		expect(progress).toEqual(["A browser window should open. Complete login to finish."]);
	});

	it("logs in through the provider adapter", async () => {
		await waitForOAuthRuntime();
		const authUrls: string[] = [];
		const fetchMock = stubTokenExchange(globalThis.fetch.bind(globalThis), { accountId: "account-provider" });

		await expect(
			openaiCodexOAuthProvider.login({
				onAuth: ({ url }) => {
					authUrls.push(url);
				},
				onPrompt: async () => "unused",
				onManualCodeInput: async () => {
					const authUrl = authUrls.at(-1);
					if (!authUrl) throw new Error("missing auth url");
					const state = new URL(authUrl).searchParams.get("state");
					return `manual-code#${state}`;
				},
			}),
		).resolves.toMatchObject({
			access: accessToken("account-provider"),
			accountId: "account-provider",
		});
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("logs in from the local browser callback", async () => {
		await waitForOAuthRuntime();
		vi.setSystemTime(200_000);
		const realFetch = globalThis.fetch.bind(globalThis);
		const fetchMock = stubTokenExchange(realFetch, { accountId: "account-browser", refresh: "refresh-browser" });
		const callbackStatuses: number[] = [];
		let callbackPromise: Promise<void> | undefined;

		await expect(
			loginOpenAICodex({
				onAuth: ({ url }) => {
					const state = new URL(url).searchParams.get("state");
					setTimeout(() => {
						callbackPromise = realFetch(
							`http://127.0.0.1:1455/auth/callback?code=browser-code&state=${state}`,
						).then((response) => {
							callbackStatuses.push(response.status);
						});
					}, 0);
				},
				onPrompt: async () => {
					throw new Error("prompt should not be used");
				},
			}),
		).resolves.toEqual({
			access: accessToken("account-browser"),
			refresh: "refresh-browser",
			expires: 320_000,
			accountId: "account-browser",
		});
		await callbackPromise;
		expect(callbackStatuses).toEqual([200]);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("serves callback error pages while manual query-string fallback completes", async () => {
		await waitForOAuthRuntime();
		const realFetch = globalThis.fetch.bind(globalThis);
		const fetchMock = stubTokenExchange(realFetch, { accountId: "account-fallback" });
		const callbackStatuses: number[] = [];
		let callbackState = "";

		await expect(
			loginOpenAICodex({
				onAuth: ({ url }) => {
					callbackState = new URL(url).searchParams.get("state") ?? "";
				},
				onPrompt: async () => "unused",
				onManualCodeInput: async () => {
					for (const path of [
						"/wrong-route",
						"/auth/callback?code=bad&state=wrong",
						`/auth/callback?state=${callbackState}`,
					]) {
						const response = await realFetch(`http://127.0.0.1:1455${path}`);
						callbackStatuses.push(response.status);
						expect(await response.text()).toContain("<!doctype html>");
					}
					return "code=manual-code&state=";
				},
			}),
		).resolves.toMatchObject({
			access: accessToken("account-fallback"),
			refresh: "refresh-login",
			accountId: "account-fallback",
		});
		expect(callbackStatuses).toEqual([404, 400, 400]);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("uses the browser callback when it wins the manual-input race", async () => {
		await waitForOAuthRuntime();
		const realFetch = globalThis.fetch.bind(globalThis);
		const fetchMock = stubTokenExchange(realFetch, { accountId: "account-race" });
		let callbackPromise: Promise<Response> | undefined;

		await expect(
			loginOpenAICodex({
				onAuth: ({ url }) => {
					const state = new URL(url).searchParams.get("state");
					callbackPromise = realFetch(`http://127.0.0.1:1455/auth/callback?code=browser-race&state=${state}`);
				},
				onPrompt: async () => "unused",
				onManualCodeInput: async () => new Promise<string>(() => {}),
			}),
		).resolves.toMatchObject({
			access: accessToken("account-race"),
			accountId: "account-race",
		});
		expect((await callbackPromise)?.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("prompts when callback and manual input do not provide an authorization code", async () => {
		await waitForOAuthRuntime();
		const realFetch = globalThis.fetch.bind(globalThis);
		const fetchMock = stubTokenExchange(realFetch, { accountId: "account-prompt" });

		await expect(
			loginOpenAICodex({
				onAuth: () => {},
				onPrompt: async () => "prompt-code",
				onManualCodeInput: async () => "",
			}),
		).resolves.toMatchObject({
			access: accessToken("account-prompt"),
			accountId: "account-prompt",
		});
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("rejects missing authorization codes after prompt fallback", async () => {
		await waitForOAuthRuntime();
		const fetchMock = vi.fn(async (): Promise<Response> => Response.json({}));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			loginOpenAICodex({
				onAuth: () => {},
				onPrompt: async () => "http://localhost:1455/auth/callback",
				onManualCodeInput: async () => "",
			}),
		).rejects.toThrow("Missing authorization code");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects prompt fallback state mismatches before exchanging a token", async () => {
		await waitForOAuthRuntime();
		const fetchMock = vi.fn(async (): Promise<Response> => Response.json({}));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			loginOpenAICodex({
				onAuth: () => {},
				onPrompt: async () => "code=prompt-code&state=wrong-state",
				onManualCodeInput: async () => "",
			}),
		).rejects.toThrow("State mismatch");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects manual login state mismatches before exchanging a token", async () => {
		await waitForOAuthRuntime();
		const fetchMock = vi.fn(async (): Promise<Response> => Response.json({}));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			loginOpenAICodex({
				onAuth: () => {},
				onPrompt: async () => "unused",
				onManualCodeInput: async () => "manual-code#wrong-state",
			}),
		).rejects.toThrow("State mismatch");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("surfaces manual input errors before prompt fallback", async () => {
		await waitForOAuthRuntime();
		const fetchMock = vi.fn(async (): Promise<Response> => Response.json({}));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			loginOpenAICodex({
				onAuth: () => {},
				onPrompt: async () => "unused",
				onManualCodeInput: async () => {
					throw "manual failed";
				},
			}),
		).rejects.toThrow("manual failed");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("surfaces authorization-code exchange failures", async () => {
		await waitForOAuthRuntime();
		const authUrls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => new Response("bad code", { status: 400, statusText: "Bad Request" })),
		);

		await expect(
			loginOpenAICodex({
				onAuth: ({ url }) => {
					authUrls.push(url);
				},
				onPrompt: async () => "unused",
				onManualCodeInput: async () => {
					const authUrl = authUrls.at(-1);
					if (!authUrl) throw new Error("missing auth url");
					const state = new URL(authUrl).searchParams.get("state");
					return `manual-code#${state}`;
				},
			}),
		).rejects.toThrow("OpenAI Codex token exchange failed (400): bad code");

		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => new Response("", { status: 503, statusText: "Service Unavailable" })),
		);

		await expect(
			loginOpenAICodex({
				onAuth: ({ url }) => {
					authUrls.push(url);
				},
				onPrompt: async () => "unused",
				onManualCodeInput: async () => {
					const authUrl = authUrls.at(-1);
					if (!authUrl) throw new Error("missing auth url");
					const state = new URL(authUrl).searchParams.get("state");
					return `manual-code#${state}`;
				},
			}),
		).rejects.toThrow("OpenAI Codex token exchange failed (503): Service Unavailable");
	});

	it("surfaces malformed authorization-code exchange responses", async () => {
		await waitForOAuthRuntime();
		const authUrls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => Response.json({ access_token: "access-only" })),
		);

		await expect(
			loginOpenAICodex({
				onAuth: ({ url }) => {
					authUrls.push(url);
				},
				onPrompt: async () => "unused",
				onManualCodeInput: async () => {
					const authUrl = authUrls.at(-1);
					if (!authUrl) throw new Error("missing auth url");
					const state = new URL(authUrl).searchParams.get("state");
					return `manual-code#${state}`;
				},
			}),
		).rejects.toThrow("OpenAI Codex token exchange response missing fields");
	});

	it("rejects authorization-code exchanges with malformed access tokens", async () => {
		await waitForOAuthRuntime();
		const authUrls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (): Promise<Response> =>
					Response.json({
						access_token: "header.@@@.signature",
						refresh_token: "refresh-login",
						expires_in: 120,
					}),
			),
		);

		await expect(
			loginOpenAICodex({
				onAuth: ({ url }) => {
					authUrls.push(url);
				},
				onPrompt: async () => "unused",
				onManualCodeInput: async () => {
					const authUrl = authUrls.at(-1);
					if (!authUrl) throw new Error("missing auth url");
					const state = new URL(authUrl).searchParams.get("state");
					return `manual-code#${state}`;
				},
			}),
		).rejects.toThrow("Failed to extract accountId from token");
	});

	it("falls back to prompt input when the local callback port is unavailable", async () => {
		await waitForOAuthRuntime();
		const blocker = createServer((_req, res) => {
			res.statusCode = 409;
			res.end("blocked");
		});
		await new Promise<void>((resolve) => blocker.listen(1455, "127.0.0.1", () => resolve()));
		const fetchMock = stubTokenExchange(globalThis.fetch.bind(globalThis), { accountId: "account-port" });

		try {
			await expect(
				loginOpenAICodex({
					onAuth: () => {},
					onPrompt: async () => "prompt-code",
				}),
			).resolves.toMatchObject({
				access: accessToken("account-port"),
				accountId: "account-port",
			});
			expect(fetchMock).toHaveBeenCalledOnce();
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("accepts delayed manual input when the local callback server cannot start", async () => {
		await waitForOAuthRuntime();
		const blocker = createServer((_req, res) => {
			res.statusCode = 409;
			res.end("blocked");
		});
		await new Promise<void>((resolve) => blocker.listen(1455, "127.0.0.1", () => resolve()));
		const fetchMock = stubTokenExchange(globalThis.fetch.bind(globalThis), { accountId: "account-delayed-manual" });
		let authState = "";

		try {
			await expect(
				loginOpenAICodex({
					onAuth: ({ url }) => {
						authState = new URL(url).searchParams.get("state") ?? "";
					},
					onPrompt: async () => "unused",
					onManualCodeInput: async () => {
						await new Promise((resolve) => setTimeout(resolve, 0));
						return `manual-code#${authState}`;
					},
				}),
			).resolves.toMatchObject({
				access: accessToken("account-delayed-manual"),
				accountId: "account-delayed-manual",
			});
			expect(fetchMock).toHaveBeenCalledOnce();
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("surfaces delayed manual input errors when the callback server cannot start", async () => {
		await waitForOAuthRuntime();
		const blocker = createServer((_req, res) => {
			res.statusCode = 409;
			res.end("blocked");
		});
		await new Promise<void>((resolve) => blocker.listen(1455, "127.0.0.1", () => resolve()));
		const fetchMock = vi.fn(async (): Promise<Response> => Response.json({}));
		vi.stubGlobal("fetch", fetchMock);

		try {
			await expect(
				loginOpenAICodex({
					onAuth: () => {},
					onPrompt: async () => "unused",
					onManualCodeInput: async () => {
						await new Promise((resolve) => setTimeout(resolve, 0));
						throw new Error("delayed manual failed");
					},
				}),
			).rejects.toThrow("delayed manual failed");
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("rejects delayed manual input state mismatches when the callback server cannot start", async () => {
		await waitForOAuthRuntime();
		const blocker = createServer((_req, res) => {
			res.statusCode = 409;
			res.end("blocked");
		});
		await new Promise<void>((resolve) => blocker.listen(1455, "127.0.0.1", () => resolve()));
		const fetchMock = vi.fn(async (): Promise<Response> => Response.json({}));
		vi.stubGlobal("fetch", fetchMock);

		try {
			await expect(
				loginOpenAICodex({
					onAuth: () => {},
					onPrompt: async () => "unused",
					onManualCodeInput: async () => {
						await new Promise((resolve) => setTimeout(resolve, 0));
						return "manual-code#wrong-state";
					},
				}),
			).rejects.toThrow("State mismatch");
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});
});
