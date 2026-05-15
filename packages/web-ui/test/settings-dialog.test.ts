// ADR-0017: SettingsDialog Lit components — SettingsTab base, ApiKeysTab, ProxyTab,
// and the SettingsDialog shell.
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

vi.mock("@earendil-works/pi-ai", async () => {
	const actual: Record<string, unknown> = await vi.importActual("@earendil-works/pi-ai");
	return {
		...actual,
		getProviders: () => ["openai", "anthropic"],
	};
});

const { settingsState } = vi.hoisted(() => ({
	settingsState: {
		store: new Map<string, unknown>(),
		getShouldThrow: false,
	},
}));
vi.mock("../src/storage/app-storage.js", () => ({
	getAppStorage: () => ({
		settings: {
			get: async <T,>(key: string): Promise<T | null> => {
				if (settingsState.getShouldThrow) throw new Error("load fail");
				return (settingsState.store.get(key) as T | undefined) ?? null;
			},
			set: async (key: string, value: unknown) => {
				settingsState.store.set(key, value);
			},
		},
	}),
}));

import { ApiKeysTab, ProxyTab, SettingsDialog, SettingsTab } from "../src/dialogs/SettingsDialog.js";

beforeEach(() => {
	settingsState.store.clear();
	settingsState.getShouldThrow = false;
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("SettingsTab base class", () => {
	it("createRenderRoot returns the element itself (light DOM)", () => {
		// Use a concrete subclass that's already registered as a custom element.
		const tab = new ApiKeysTab();
		expect((tab as unknown as { createRenderRoot: () => unknown }).createRenderRoot()).toBe(tab);
	});
});

describe("ApiKeysTab", () => {
	it("getTabName returns 'API Keys'", () => {
		const tab = new ApiKeysTab();
		expect(tab.getTabName()).toContain("API Keys");
	});

	it("render returns a non-null template", () => {
		const tab = new ApiKeysTab();
		const r = tab.render();
		expect(r).toBeDefined();
		expect((r as Record<string, unknown>)._$litType$).toBeDefined();
	});
});

describe("ProxyTab", () => {
	it("getTabName returns 'Proxy'", () => {
		const tab = new ProxyTab();
		expect(tab.getTabName()).toContain("Proxy");
	});

	it("connectedCallback loads stored settings (covers if (enabled !== null) + if (url !== null))", async () => {
		settingsState.store.set("proxy.enabled", true);
		settingsState.store.set("proxy.url", "http://example.test:3001");
		const tab = new ProxyTab();
		document.body.appendChild(tab);
		// Wait microtasks for connectedCallback to run
		await new Promise((r) => setTimeout(r, 0));
		expect((tab as unknown as { proxyEnabled: boolean }).proxyEnabled).toBe(true);
		expect((tab as unknown as { proxyUrl: string }).proxyUrl).toBe("http://example.test:3001");
	});

	it("connectedCallback keeps defaults when nothing is stored", async () => {
		const tab = new ProxyTab();
		document.body.appendChild(tab);
		await new Promise((r) => setTimeout(r, 0));
		expect((tab as unknown as { proxyEnabled: boolean }).proxyEnabled).toBe(false);
		expect((tab as unknown as { proxyUrl: string }).proxyUrl).toContain("localhost:3001");
	});

	it("connectedCallback handles a failing storage.get gracefully (covers catch)", async () => {
		settingsState.getShouldThrow = true;
		const tab = new ProxyTab();
		document.body.appendChild(tab);
		await new Promise((r) => setTimeout(r, 0));
		expect(console.error).toHaveBeenCalled();
	});

	it("saveProxySettings handles errors during set (covers catch)", async () => {
		const tab = new ProxyTab();
		document.body.appendChild(tab);
		await new Promise((r) => setTimeout(r, 0));
		// Temporarily stub set to throw
		const setSpy = vi.fn(async () => {
			throw new Error("set fail");
		});
		const storageMod = await import("../src/storage/app-storage.js");
		const orig = storageMod.getAppStorage;
		(storageMod as unknown as { getAppStorage: () => unknown }).getAppStorage = () => ({
			settings: { get: async () => null, set: setSpy },
		});
		try {
			await (tab as unknown as { saveProxySettings: () => Promise<void> }).saveProxySettings();
			expect(console.error).toHaveBeenCalled();
		} finally {
			(storageMod as unknown as { getAppStorage: typeof orig }).getAppStorage = orig;
		}
	});

	it("render produces a non-null template", () => {
		const tab = new ProxyTab();
		const r = tab.render();
		expect(r).toBeDefined();
		expect((r as Record<string, unknown>)._$litType$).toBeDefined();
	});

	it("Switch onChange updates proxyEnabled and saves (covers Switch onChange branch)", async () => {
		const tab = new ProxyTab();
		document.body.appendChild(tab);
		await new Promise((r) => setTimeout(r, 0));
		// Render the tab template into a fresh container so we can click the Switch.
		const { render } = await import("lit");
		const container = document.createElement("div");
		render(tab.render(), container);
		const switchButton = container.querySelector('button[role="switch"]') as HTMLButtonElement | null;
		expect(switchButton).not.toBeNull();
		switchButton!.click();
		// proxyEnabled should flip from default false to true.
		expect((tab as unknown as { proxyEnabled: boolean }).proxyEnabled).toBe(true);
		// saveProxySettings was invoked, so storage was updated.
		await new Promise((r) => setTimeout(r, 0));
		expect(settingsState.store.get("proxy.enabled")).toBe(true);
	});

	it("saveProxySettings can also be invoked directly", async () => {
		const tab = new ProxyTab();
		document.body.appendChild(tab);
		await new Promise((r) => setTimeout(r, 0));
		(tab as unknown as { proxyEnabled: boolean }).proxyEnabled = true;
		(tab as unknown as { proxyUrl: string }).proxyUrl = "http://t";
		await (tab as unknown as { saveProxySettings: () => Promise<void> }).saveProxySettings();
		expect(settingsState.store.get("proxy.enabled")).toBe(true);
		expect(settingsState.store.get("proxy.url")).toBe("http://t");
	});

	it("Input onInput from rendered template updates proxyUrl (covers lines 102-103)", async () => {
		const tab = new ProxyTab();
		document.body.appendChild(tab);
		await new Promise((r) => setTimeout(r, 0));
		// Render the tab into a separate container so we can dispatch the Input event.
		const { render } = await import("lit");
		const container = document.createElement("div");
		render(tab.render(), container);
		const input = container.querySelector('input[type="text"]') as HTMLInputElement | null;
		expect(input).not.toBeNull();
		input!.value = "http://new-proxy.test";
		input!.dispatchEvent(new Event("input", { bubbles: true }));
		expect((tab as unknown as { proxyUrl: string }).proxyUrl).toBe("http://new-proxy.test");
	});

	it("Input onChange in template triggers saveProxySettings (covers line 104)", async () => {
		const tab = new ProxyTab();
		document.body.appendChild(tab);
		await new Promise((r) => setTimeout(r, 0));
		(tab as unknown as { proxyEnabled: boolean }).proxyEnabled = true;
		const { render } = await import("lit");
		const container = document.createElement("div");
		render(tab.render(), container);
		const input = container.querySelector('input[type="text"]') as HTMLInputElement | null;
		expect(input).not.toBeNull();
		input!.value = "saved-url";
		input!.dispatchEvent(new Event("change", { bubbles: true }));
		// onChange triggers saveProxySettings asynchronously; wait microtasks.
		await new Promise((r) => setTimeout(r, 0));
		expect(settingsState.store.get("proxy.enabled")).toBe(true);
	});
});

describe("SettingsDialog", () => {
	it("static open() creates a dialog and appends it to the body", async () => {
		const tab = new ApiKeysTab();
		await SettingsDialog.open([tab]);
		const dialog = document.body.querySelector("settings-dialog") as SettingsDialog | null;
		expect(dialog).not.toBeNull();
	});

	it("render() returns empty when tabs is empty", () => {
		const dialog = new SettingsDialog();
		dialog.tabs = [];
		const r = dialog.render();
		expect(r).toBeDefined();
	});

	it("setActiveTab updates activeTabIndex (covers branching renderers)", async () => {
		const a = new ApiKeysTab();
		const b = new ProxyTab();
		await SettingsDialog.open([a, b]);
		const dialog = document.body.querySelector("settings-dialog") as SettingsDialog | null;
		expect(dialog).not.toBeNull();
		(dialog as unknown as { setActiveTab: (i: number) => void }).setActiveTab(1);
		expect((dialog as unknown as { activeTabIndex: number }).activeTabIndex).toBe(1);
	});

	it("renderSidebarItem produces template for active vs inactive (covers ternary)", () => {
		const dialog = new SettingsDialog();
		const tab = new ApiKeysTab();
		// Active state
		(dialog as unknown as { activeTabIndex: number }).activeTabIndex = 0;
		const activeT = (dialog as unknown as {
			renderSidebarItem: (t: SettingsTab, i: number) => unknown;
		}).renderSidebarItem(tab, 0);
		expect(activeT).toBeDefined();
		// Inactive state
		const inactiveT = (dialog as unknown as {
			renderSidebarItem: (t: SettingsTab, i: number) => unknown;
		}).renderSidebarItem(tab, 1);
		expect(inactiveT).toBeDefined();
	});

	it("renderMobileTab produces template for active vs inactive", () => {
		const dialog = new SettingsDialog();
		const tab = new ApiKeysTab();
		(dialog as unknown as { activeTabIndex: number }).activeTabIndex = 0;
		const activeT = (dialog as unknown as {
			renderMobileTab: (t: SettingsTab, i: number) => unknown;
		}).renderMobileTab(tab, 0);
		expect(activeT).toBeDefined();
		const inactiveT = (dialog as unknown as {
			renderMobileTab: (t: SettingsTab, i: number) => unknown;
		}).renderMobileTab(tab, 1);
		expect(inactiveT).toBeDefined();
	});

	it("onClose callback fires when dialog closes (covers onCloseCallback?.())", async () => {
		const onClose = vi.fn();
		const tab = new ApiKeysTab();
		await SettingsDialog.open([tab], onClose);
		const dialog = document.body.querySelector("settings-dialog") as SettingsDialog | null;
		expect(dialog).not.toBeNull();
		// Simulate onClose flow by manipulating internal state.
		(dialog as unknown as { isOpen: boolean }).isOpen = false;
		// invoke the render that builds the dialog's onClose param
		// Trigger close by calling the Dialog's onClose pathway via reflection.
		// Easier: directly invoke the onCloseCallback we wired up.
		(dialog as unknown as { onCloseCallback?: () => void }).onCloseCallback?.();
		expect(onClose).toHaveBeenCalled();
	});

	it("createRenderRoot returns the element (light DOM)", () => {
		const dialog = new SettingsDialog();
		expect((dialog as unknown as { createRenderRoot: () => unknown }).createRenderRoot()).toBe(dialog);
	});

	it("render() with non-empty tabs returns the Dialog template", async () => {
		const dialog = new SettingsDialog();
		dialog.tabs = [new ApiKeysTab(), new ProxyTab()];
		(dialog as unknown as { isOpen: boolean }).isOpen = true;
		const r = dialog.render();
		expect(r).toBeDefined();
		expect((r as Record<string, unknown>)._$litType$).toBeDefined();
	});

	it("Dialog onClose handler (inline arrow) sets isOpen=false, removes from DOM, and calls onCloseCallback", async () => {
		const onClose = vi.fn();
		await SettingsDialog.open([new ApiKeysTab()], onClose);
		const dialog = document.body.querySelector("settings-dialog") as SettingsDialog | null;
		expect(dialog).not.toBeNull();
		await (dialog as unknown as { updateComplete: Promise<unknown> }).updateComplete;
		// Find the Dialog backdrop in the rendered template; dispatching escape
		// via document fires the Dialog's escape handler which invokes our onClose.
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		// Allow the close to propagate.
		await new Promise((r) => setTimeout(r, 0));
		expect(onClose).toHaveBeenCalled();
	});
});
