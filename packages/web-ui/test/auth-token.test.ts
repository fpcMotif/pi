// ADR-0017 phase C.7: cover auth-token.ts — localStorage-backed token
// helper with a PromptDialog fallback.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { promptAskMock } = vi.hoisted(() => ({ promptAskMock: vi.fn() }));
vi.mock("@mariozechner/mini-lit/dist/PromptDialog.js", () => ({
	default: { ask: promptAskMock },
}));
vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));

// happy-dom requires explicit localStorage config; supply a small in-mem shim.
const localStore = new Map<string, string>();
const localStorageShim = {
	getItem: (k: string) => localStore.get(k) ?? null,
	setItem: (k: string, v: string) => {
		localStore.set(k, v);
	},
	removeItem: (k: string) => {
		localStore.delete(k);
	},
	clear: () => {
		localStore.clear();
	},
	key: (i: number) => Array.from(localStore.keys())[i] ?? null,
	get length() {
		return localStore.size;
	},
};
Object.defineProperty(globalThis, "localStorage", { value: localStorageShim, configurable: true });

import { clearAuthToken, getAuthToken } from "../src/utils/auth-token.js";

beforeEach(() => {
	localStorage.clear();
	promptAskMock.mockReset();
});

afterEach(() => {
	localStorage.clear();
});

describe("getAuthToken", () => {
	it("returns the stored token without prompting when localStorage already has it", async () => {
		localStorage.setItem("auth-token", "stored-token");
		const token = await getAuthToken();
		expect(token).toBe("stored-token");
		expect(promptAskMock).not.toHaveBeenCalled();
	});

	it("prompts the user when no token is stored, persists the result, returns it", async () => {
		promptAskMock.mockResolvedValueOnce("entered-token");
		const token = await getAuthToken();
		expect(token).toBe("entered-token");
		expect(localStorage.getItem("auth-token")).toBe("entered-token");
		expect(promptAskMock).toHaveBeenCalledOnce();
	});

	it("re-prompts when the user enters empty input until they provide a real token", async () => {
		promptAskMock.mockResolvedValueOnce("").mockResolvedValueOnce("   ").mockResolvedValueOnce("finally");
		const token = await getAuthToken();
		expect(token).toBe("finally");
		expect(promptAskMock).toHaveBeenCalledTimes(3);
		expect(localStorage.getItem("auth-token")).toBe("finally");
	});

	it("handles null return from the prompt dialog as an empty input (re-prompts)", async () => {
		promptAskMock.mockResolvedValueOnce(null).mockResolvedValueOnce("ok");
		const token = await getAuthToken();
		expect(token).toBe("ok");
		expect(promptAskMock).toHaveBeenCalledTimes(2);
	});

	it("trims whitespace from the entered token before persisting", async () => {
		promptAskMock.mockResolvedValueOnce("  spaced  ");
		const token = await getAuthToken();
		expect(token).toBe("spaced");
		expect(localStorage.getItem("auth-token")).toBe("spaced");
	});
});

describe("clearAuthToken", () => {
	it("removes the auth-token from localStorage", async () => {
		localStorage.setItem("auth-token", "x");
		await clearAuthToken();
		expect(localStorage.getItem("auth-token")).toBeNull();
	});

	it("is a no-op when no token is set (no throw)", async () => {
		await expect(clearAuthToken()).resolves.toBeUndefined();
	});
});
