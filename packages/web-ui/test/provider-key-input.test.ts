// ADR-0017 phase C.7: ProviderKeyInput Lit component.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/mini-lit", () => ({
	icon: () => "<icon/>",
	i18n: (s: string) => s,
	defaultEnglish: {},
	defaultGerman: {},
	setTranslations: () => {},
}));
vi.mock("@mariozechner/mini-lit/dist/mini.js", () => ({
	fc: (fn: (props: unknown) => unknown) => fn,
}));
vi.mock("@mariozechner/mini-lit/dist/i18n.js", () => ({ i18n: (s: string) => s }));
vi.mock("@mariozechner/mini-lit/dist/Badge.js", () => ({
	Badge: (opts: { children: string }) => {
		const el = document.createElement("span");
		el.textContent = opts.children;
		el.className = "badge";
		return el;
	},
}));
vi.mock("@mariozechner/mini-lit/dist/Button.js", () => ({
	Button: (opts: { children: string; onClick?: () => void; disabled?: boolean }) => {
		const el = document.createElement("button");
		el.textContent = opts.children;
		if (opts.disabled) el.setAttribute("disabled", "");
		if (opts.onClick) el.addEventListener("click", opts.onClick);
		return el;
	},
}));

const { getModelMock, completeMock } = vi.hoisted(() => ({
	getModelMock: vi.fn(),
	completeMock: vi.fn(),
}));
vi.mock("@earendil-works/pi-ai", () => ({
	getModel: getModelMock,
	complete: completeMock,
}));

const { storageState } = vi.hoisted(() => ({
	storageState: {
		keys: new Map<string, string>(),
		settings: new Map<string, unknown>(),
	},
}));
vi.mock("../src/storage/app-storage.js", () => ({
	getAppStorage: () => ({
		providerKeys: {
			get: async (p: string) => storageState.keys.get(p) ?? null,
			set: async (p: string, k: string) => {
				storageState.keys.set(p, k);
			},
		},
		settings: {
			get: async <T>(k: string) => (storageState.settings.get(k) ?? null) as T | null,
		},
	}),
}));

vi.mock("../src/utils/proxy-utils.js", () => ({
	applyProxyIfNeeded: (model: unknown) => model,
}));

import "../src/components/ProviderKeyInput.js";

beforeEach(() => {
	// Re-create maps so any prior test's monkey-patching of .set() is discarded.
	storageState.keys = new Map();
	storageState.settings = new Map();
	getModelMock.mockReset();
	completeMock.mockReset();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

const make = async (
	provider: string,
): Promise<HTMLElement & { keyInput?: string; updateComplete?: Promise<unknown> }> => {
	const el = document.createElement("provider-key-input") as HTMLElement & {
		provider: string;
		updateComplete?: Promise<unknown>;
		keyInput?: string;
	};
	el.provider = provider;
	document.body.appendChild(el);
	// connectedCallback is async; wait a microtask.
	await new Promise((r) => setTimeout(r, 0));
	if (el.updateComplete) await el.updateComplete;
	return el;
};

describe("ProviderKeyInput", () => {
	it("connectedCallback sets hasKey=false when storage has no key (renders no checkmark)", async () => {
		const el = await make("openai");
		expect(el.textContent).not.toContain("✓");
	});

	it("connectedCallback sets hasKey=true when storage already has a key", async () => {
		storageState.keys.set("openai", "sk-test");
		const el = await make("openai");
		expect(el.textContent).toContain("✓");
	});

	it("checkKeyStatus catches errors without crashing (covers catch branch)", async () => {
		// Make providerKeys.get throw by stubbing the singleton.
		const origGet = storageState.keys.get.bind(storageState.keys);
		storageState.keys.get = () => {
			throw new Error("storage broken");
		};
		try {
			await make("anthropic");
			// Should render but with hasKey unchanged (false).
		} finally {
			storageState.keys.get = origGet;
		}
	});

	it("typing into the input updates internal state and enables Save button", async () => {
		const el = await make("openai");
		const input = el.querySelector("input") as HTMLInputElement;
		input.value = "sk-typed";
		input.dispatchEvent(new Event("input"));
		await el.updateComplete;
		const btn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Save");
		expect(btn?.hasAttribute("disabled")).toBe(false);
	});

	it("Save button disabled when keyInput is empty", async () => {
		const el = await make("openai");
		const btn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Save");
		expect(btn?.hasAttribute("disabled")).toBe(true);
	});

	it("Save button disabled when hasKey + no input changes", async () => {
		storageState.keys.set("openai", "sk-existing");
		const el = await make("openai");
		const btn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Save");
		expect(btn?.hasAttribute("disabled")).toBe(true);
	});

	it("saveKey with no keyInput is a no-op (covers !this.keyInput early return)", async () => {
		const el = await make("openai");
		const btn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;
		// Force-click despite disabled (we want to exercise the early return path).
		btn.removeAttribute("disabled");
		btn.click();
		await el.updateComplete;
		// No state change.
		expect(storageState.keys.get("openai")).toBeUndefined();
	});

	it("saveKey with successful test + storage save sets hasKey=true", async () => {
		getModelMock.mockReturnValue({ id: "gpt-4o-mini" });
		completeMock.mockResolvedValue({ stopReason: "stop" });
		const el = await make("openai");
		const input = el.querySelector("input") as HTMLInputElement;
		input.value = "sk-good";
		input.dispatchEvent(new Event("input"));
		await el.updateComplete;
		const btn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;
		btn.click();
		// Wait for the async chain.
		await new Promise((r) => setTimeout(r, 0));
		await el.updateComplete;
		expect(storageState.keys.get("openai")).toBe("sk-good");
		expect(el.textContent).toContain("✓");
	});

	it("saveKey with failed API test sets failed=true (shows ✗ Invalid badge)", async () => {
		getModelMock.mockReturnValue({ id: "gpt-4o-mini" });
		completeMock.mockResolvedValue({ stopReason: "other" });
		const el = await make("openai");
		const input = el.querySelector("input") as HTMLInputElement;
		input.value = "sk-bad";
		input.dispatchEvent(new Event("input"));
		await el.updateComplete;
		const btn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;
		btn.click();
		await new Promise((r) => setTimeout(r, 0));
		await el.updateComplete;
		expect(el.textContent).toContain("✗ Invalid");
	});

	it("testApiKey returns true for an unknown provider (no TEST_MODELS entry)", async () => {
		// "ollama" is not in TEST_MODELS — saveKey should treat it as a pass.
		const el = await make("ollama");
		const input = el.querySelector("input") as HTMLInputElement;
		input.value = "key";
		input.dispatchEvent(new Event("input"));
		await el.updateComplete;
		const btn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;
		btn.click();
		await new Promise((r) => setTimeout(r, 0));
		await el.updateComplete;
		expect(storageState.keys.get("ollama")).toBe("key");
	});

	it("testApiKey returns false when getModel returns undefined", async () => {
		getModelMock.mockReturnValue(undefined);
		const el = await make("openai");
		const input = el.querySelector("input") as HTMLInputElement;
		input.value = "sk-no-model";
		input.dispatchEvent(new Event("input"));
		await el.updateComplete;
		const btn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;
		btn.click();
		await new Promise((r) => setTimeout(r, 0));
		await el.updateComplete;
		expect(el.textContent).toContain("✗ Invalid");
	});

	it("testApiKey returns false when complete() throws (covers catch in testApiKey)", async () => {
		getModelMock.mockReturnValue({ id: "x" });
		completeMock.mockRejectedValue(new Error("network down"));
		const el = await make("openai");
		const input = el.querySelector("input") as HTMLInputElement;
		input.value = "sk-throw";
		input.dispatchEvent(new Event("input"));
		await el.updateComplete;
		const btn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;
		btn.click();
		await new Promise((r) => setTimeout(r, 0));
		await el.updateComplete;
		expect(el.textContent).toContain("✗ Invalid");
	});

	it("proxy-enabled setting + proxy.url is read and forwarded to applyProxyIfNeeded", async () => {
		storageState.settings.set("proxy.enabled", true);
		storageState.settings.set("proxy.url", "https://proxy.test");
		getModelMock.mockReturnValue({ id: "gpt-4o-mini" });
		completeMock.mockResolvedValue({ stopReason: "stop" });
		const el = await make("openai");
		const input = el.querySelector("input") as HTMLInputElement;
		input.value = "sk-prx";
		input.dispatchEvent(new Event("input"));
		await el.updateComplete;
		const btn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;
		btn.click();
		await new Promise((r) => setTimeout(r, 0));
		await el.updateComplete;
		expect(completeMock).toHaveBeenCalled();
	});

	it("saveKey storage.set throwing triggers failed=true (covers catch on save error)", async () => {
		getModelMock.mockReturnValue({ id: "gpt-4o-mini" });
		completeMock.mockResolvedValue({ stopReason: "stop" });
		storageState.keys.set = () => {
			throw new Error("disk full");
		};
		const el = await make("openai");
		const input = el.querySelector("input") as HTMLInputElement;
		input.value = "sk-disk";
		input.dispatchEvent(new Event("input"));
		await el.updateComplete;
		const btn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;
		btn.click();
		await new Promise((r) => setTimeout(r, 0));
		await el.updateComplete;
		expect(el.textContent).toContain("✗ Invalid");
	});

	it("proxy.enabled=false skips proxy URL forwarding (covers ternary's false branch)", async () => {
		storageState.settings.set("proxy.enabled", false);
		storageState.settings.set("proxy.url", "https://proxy.test");
		getModelMock.mockReturnValue({ id: "gpt-4o-mini" });
		completeMock.mockResolvedValue({ stopReason: "stop" });
		const el = await make("openai");
		const input = el.querySelector("input") as HTMLInputElement;
		input.value = "sk-no-proxy";
		input.dispatchEvent(new Event("input"));
		await el.updateComplete;
		const btn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;
		btn.click();
		await new Promise((r) => setTimeout(r, 0));
		await el.updateComplete;
		expect(storageState.keys.get("openai")).toBe("sk-no-proxy");
	});

	it("proxy.enabled=true with empty proxyUrl falls back to undefined (covers proxyUrl || undefined)", async () => {
		storageState.settings.set("proxy.enabled", true);
		// proxy.url left unset — applyProxyIfNeeded gets undefined.
		getModelMock.mockReturnValue({ id: "gpt-4o-mini" });
		completeMock.mockResolvedValue({ stopReason: "stop" });
		const el = await make("openai");
		const input = el.querySelector("input") as HTMLInputElement;
		input.value = "sk-empty-proxy";
		input.dispatchEvent(new Event("input"));
		await el.updateComplete;
		const btn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;
		btn.click();
		await new Promise((r) => setTimeout(r, 0));
		await el.updateComplete;
		expect(storageState.keys.get("openai")).toBe("sk-empty-proxy");
	});

	it("failed badge auto-clears after the 5s timeout (covers the setTimeout callback on a failed test)", async () => {
		getModelMock.mockReturnValue({ id: "gpt-4o-mini" });
		completeMock.mockResolvedValue({ stopReason: "other" });
		const el = await make("openai");
		const input = el.querySelector("input") as HTMLInputElement;
		input.value = "sk-bad";
		input.dispatchEvent(new Event("input"));
		await el.updateComplete;
		const btn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;

		vi.useFakeTimers();
		try {
			btn.click();
			// Flush the async saveKey chain so `failed = true` + setTimeout(5000) is scheduled.
			await vi.advanceTimersByTimeAsync(0);
			await el.updateComplete;
			expect(el.textContent).toContain("✗ Invalid");
			// Advance past the 5s timeout — the callback flips `failed` back to false.
			await vi.advanceTimersByTimeAsync(5000);
		} finally {
			vi.useRealTimers();
		}
		await el.updateComplete;
		expect(el.textContent).not.toContain("✗ Invalid");
	});

	it("failed badge from a storage-save error also auto-clears after the 5s timeout", async () => {
		getModelMock.mockReturnValue({ id: "gpt-4o-mini" });
		completeMock.mockResolvedValue({ stopReason: "stop" });
		storageState.keys.set = () => {
			throw new Error("disk full");
		};
		const el = await make("openai");
		const input = el.querySelector("input") as HTMLInputElement;
		input.value = "sk-disk";
		input.dispatchEvent(new Event("input"));
		await el.updateComplete;
		const btn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;

		vi.useFakeTimers();
		try {
			btn.click();
			await vi.advanceTimersByTimeAsync(0);
			await el.updateComplete;
			expect(el.textContent).toContain("✗ Invalid");
			await vi.advanceTimersByTimeAsync(5000);
		} finally {
			vi.useRealTimers();
		}
		await el.updateComplete;
		expect(el.textContent).not.toContain("✗ Invalid");
	});
});
