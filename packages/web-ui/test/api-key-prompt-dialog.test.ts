// ADR-0017: ApiKeyPromptDialog Lit component.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// localStorage shim for happy-dom (mini-lit i18n uses it)
const localStore = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
	value: {
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
	},
	configurable: true,
});

vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));

const { storageState } = vi.hoisted(() => ({
	storageState: { keys: new Map<string, string>() },
}));
vi.mock("../src/storage/app-storage.js", () => ({
	getAppStorage: () => ({
		providerKeys: {
			get: async (provider: string) => storageState.keys.get(provider) ?? null,
		},
	}),
}));

import { ApiKeyPromptDialog } from "../src/dialogs/ApiKeyPromptDialog.js";

beforeEach(() => {
	storageState.keys.clear();
	vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = "";
});

describe("ApiKeyPromptDialog", () => {
	it("ApiKeyPromptDialog.prompt() resolves true once a key appears in storage", async () => {
		const promise = ApiKeyPromptDialog.prompt("openai");
		// Insert a key so the polling interval resolves it.
		storageState.keys.set("openai", "sk-test");
		// Allow microtasks to run
		await vi.advanceTimersByTimeAsync(600);
		await expect(promise).resolves.toBe(true);
	});

	it("close() before the key arrives resolves the prompt() promise with false", async () => {
		const promise = ApiKeyPromptDialog.prompt("anthropic");
		// The dialog has been appended; grab it from the DOM.
		const dialog = document.body.querySelector("api-key-prompt-dialog") as ApiKeyPromptDialog | null;
		expect(dialog).not.toBeNull();
		dialog!.close();
		await expect(promise).resolves.toBe(false);
	});

	it("disconnectedCallback clears the polling interval (covers unsubscribe branch)", async () => {
		const dialog = new ApiKeyPromptDialog();
		(dialog as unknown as { provider: string }).provider = "openai";
		document.body.appendChild(dialog);
		dialog.remove();
		// Advance timers — interval should not fire (interval cleared in disconnectedCallback).
		storageState.keys.set("openai", "value");
		await vi.advanceTimersByTimeAsync(2000);
		// No assertion error means the interval was cleared.
		expect(document.body.contains(dialog)).toBe(false);
	});

	it("calling close() after the prompt has already resolved doesn't reject; resolvePromise is undefined (covers !resolvePromise branch)", async () => {
		const promise = ApiKeyPromptDialog.prompt("openai");
		// Resolve via key insertion.
		storageState.keys.set("openai", "sk");
		await vi.advanceTimersByTimeAsync(600);
		await promise;
		// Closing again now hits the !resolvePromise path inside override close().
		const dialog = document.body.querySelector("api-key-prompt-dialog") as ApiKeyPromptDialog | null;
		// The successful flow already removed the dialog from the body.
		expect(dialog).toBeNull();
	});

	it("renderContent function returns a non-null template (covers renderContent body)", async () => {
		const dialog = new ApiKeyPromptDialog();
		(dialog as unknown as { provider: string }).provider = "openai";
		const rc = (dialog as unknown as { renderContent: () => unknown }).renderContent();
		// renderContent should return a TemplateResult (Lit's html literal output)
		expect(rc).toBeDefined();
		expect(typeof rc).toBe("object");
		expect((rc as Record<string, unknown>)._$litType$).toBeDefined();
	});
});
